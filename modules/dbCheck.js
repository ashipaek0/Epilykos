/** Background SQLite integrity checks. Results survive a damaged config table. */
'use strict';
const fs = require('fs');
const path = require('path');
const { runSqliteProcess } = require('./sqliteCheck');
const { DB_PATH } = require('./database');
const { logger } = require('./logger');
const { acquireLock } = require('./maintenanceLock');
const WEEK_MS = 7 * 86400000;
let file = DB_PATH, marker = path.join(path.dirname(DB_PATH), '.running');
let resultFile = path.join(path.dirname(DB_PATH), 'db-check.json');
let running = null, controller = null, timers = [], stopping = false;
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
      if (stopping) return { cancelled: true };
      const started = Date.now();
      controller = new AbortController();
      let result;
      try {
        // A worker thread cannot interrupt native SQLite. The supervised child
        // can be killed and reaped, retaining the shared lease until it exits.
        const message = await runSqliteProcess('dbCheckProcess.js', [file], {
          signal: controller.signal,
          leaseFds: release.leaseFd === undefined ? [] : [release.leaseFd]
        });
        const rows = message.rows;
        result = { ok: rows.length === 1 && rows[0] === 'ok', problems: rows[0] === 'ok' ? [] : rows.slice(0, 5) };
      } catch (error) {
        if (stopping) return { cancelled: true };
        result = { ok: false, problems: [error.message] };
      }
      if (stopping) return { cancelled: true };
      const out = { ...result, at: new Date().toISOString(), reason, ms: Date.now() - started };
      try {
        fs.writeFileSync(resultFile + '.tmp', JSON.stringify(out) + '\n');
        fs.renameSync(resultFile + '.tmp', resultFile);
      } catch (error) { logger.warn(`[db-check] Cannot save result: ${error.message}`); }
      logger[out.ok ? 'info' : 'error'](`[db-check] ${out.ok ? 'Database OK' : out.problems.join('; ')}`);
      return out;
    } catch (error) { return stopping ? { cancelled: true } : { ok: false, problems: [error.message] }; }
    finally { controller = null; if (release) release(); }
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
  controller?.abort(new Error('Database check cancelled by shutdown'));
  if (running) await running;
}
function setPathsForTests(f, m, r) { file = f; marker = m; resultFile = r; }
module.exports = { start, stop, run, last, markStart, markCleanStop, weeklyDue, busy: () => !!running, setPathsForTests, WEEK_MS };
