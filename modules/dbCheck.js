/** Background SQLite integrity checks. Results survive a damaged config table. */
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { DB_PATH } = require('./database');
const { logger } = require('./logger');
const { acquireLock } = require('./maintenanceLock');
const WEEK_MS = 7 * 86400000;
let file = DB_PATH, marker = path.join(path.dirname(DB_PATH), '.running');
let resultFile = path.join(path.dirname(DB_PATH), 'db-check.json');
let running = null, worker = null, timers = [], stopping = false;
function last() { try { return JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (_) { return null; } }
function markStart() {
  const unclean = fs.existsSync(marker);
  try {
    const fd = fs.openSync(marker, 'w');
    try { fs.writeSync(fd, new Date().toISOString()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) { logger.warn(`[db-check] Cannot write running marker: ${e.message}`); }
  return unclean;
}
function markCleanStop() { try { fs.unlinkSync(marker); } catch (_) {} }
function weeklyDue(now = Date.now()) {
  const at = Date.parse((last() || {}).at);
  return !Number.isFinite(at) || now - at >= WEEK_MS;
}
function run(reason = 'manual check') {
  if (running) return running;
  stopping = false;
  // Serialize with backup/restore: never inspect an inode while it is being replaced.
  running = Promise.resolve().then(async () => {
    let release;
    try {
      if (stopping) return { cancelled: true };
      release = await acquireLock('maintenance', { timeoutMs: 5000 });
      return await new Promise(resolve => {
        const started = Date.now();
        let finished = false;
        const done = result => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          if (stopping) { resolve({ cancelled: true }); return; }
          const out = { ...result, at: new Date().toISOString(), reason, ms: Date.now() - started };
          try {
            fs.writeFileSync(resultFile + '.tmp', JSON.stringify(out) + '\n');
            fs.renameSync(resultFile + '.tmp', resultFile);
          } catch (e) { logger.warn(`[db-check] Cannot save result: ${e.message}`); }
          logger[out.ok ? 'info' : 'error'](`[db-check] ${out.ok ? 'Database OK' : out.problems.join('; ')}`);
          resolve(out);
        };
        const deadline = setTimeout(() => { if (worker) worker.terminate(); done({ ok: false, problems: ['The database check timed out; try again.'] }); }, 30 * 60000);
        try {
          worker = new Worker(`
            const {parentPort,workerData}=require('worker_threads');
            const db=new (require(workerData.lib))(workerData.file,{readonly:true,fileMustExist:true});
            try { parentPort.postMessage(db.pragma('quick_check').map(r=>String(Object.values(r)[0]))); }
            finally { db.close(); }
          `, { eval: true, workerData: { file, lib: require.resolve('better-sqlite3') } });
          worker.once('message', rows => done({ ok: rows.length === 1 && rows[0] === 'ok', problems: rows[0] === 'ok' ? [] : rows.slice(0, 5) }));
          worker.once('error', e => done({ ok: false, problems: [e.message] }));
          worker.once('exit', code => { done({ ok: false, problems: [`Check stopped (worker exit ${code}); try again.`] }); });
        } catch (e) { done({ ok: false, problems: [e.message] }); }
      });
    } catch (e) { return { ok: false, problems: [e.message] }; }
    finally { if (worker) await worker.terminate(); worker = null; if (release) release(); }
  }).finally(() => { running = null; });
  return running;
}
function start() {
  const unclean = markStart();
  const tick = () => { if (weeklyDue()) run('weekly check'); };
  timers.push(setTimeout(() => { if (unclean) run('unclean shutdown'); else tick(); }, 60000));
  timers.push(setInterval(tick, 6 * 3600000));
  timers.forEach(t => t.unref());
  return unclean;
}
async function stop() {
  stopping = true;
  timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers = [];
  if (worker) await worker.terminate();
  if (running) await running;
}
function setPathsForTests(f, m, r) { file = f; marker = m; resultFile = r; }
module.exports = { start, stop, run, last, markStart, markCleanStop, weeklyDue, busy: () => !!running, setPathsForTests, WEEK_MS };
