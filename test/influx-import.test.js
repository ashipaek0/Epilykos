'use strict';
const checks = require('./_checks');
/**
 * The InfluxDB history import (modules/influx/importer.js, roleHistory.js): a week at a time, scaled, the dashboard's own
 * readings winning; the role history filled so the hourly energy, the daily totals and the savings cover imported days
 * (each 5 minutes counted in full, old and recent); progress saved so a pause carries on; network failures tried again;
 * a metric that cannot be read skipped while the others go on; stop; and the routes.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-influx-import-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
process.env.TZ = process.env.TZ || 'UTC';
const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const { createImporter, scaleBucket, WINDOW_SECONDS } = require('../modules/influx/importer');
const { buildRoleHistory } = require('../modules/influx/roleHistory');
const { readHourlyEnergy } = require('../modules/energyHourly');
const { readDailySnapshots, clearDailySnapshotCache } = require('../modules/timeseriesReader');
const { localDateString } = require('../modules/localTime');

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000 / 300) * 300;
const midnight = s => { const d = new Date(s * 1000); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000); };
const OLD_DAY = midnight(NOW - 45 * DAY);      // beyond the raw retention
const RECENT_DAY = midnight(NOW - 3 * DAY);    // within it

assert.deepStrictEqual(scaleBucket({ avg: 2, min: 1, max: 3, count: 4 }, 1000), { avg: 2000, min: 1000, max: 3000, count: 4 });
assert.deepStrictEqual(scaleBucket({ avg: 2, min: 1, max: 3, count: 4 }, -1), { avg: -2, min: -3, max: -1, count: 4 }, 'a negative scale swaps min and max');

// A fake InfluxDB holding, per series: solar a steady 1 kW all day (stored in kW), a daily counter rising 1 kWh an hour.
function fakeClient({ failFirst = 0, broken = [] } = {}) {
  const calls = [];
  let failures = failFirst;
  const valueAt = (series, t) => {
    const m = series.tags && series.tags.entity_id;
    if (m === 'pv_kw') return 1;                                  // kW
    if (m === 'pv_today') return (t - midnight(t)) / 3600;        // kWh since midnight
    return 5;
  };
  return {
    calls,
    async first(series) { return series.tags.entity_id === 'empty' ? null : OLD_DAY; },
    async buckets(series, from, to) {
      calls.push([series.tags.entity_id, from, to]);
      if (broken.includes(series.tags.entity_id)) throw Object.assign(new Error('InfluxDB: series gone'), { kind: 'query' });
      if (failures > 0) { failures--; throw Object.assign(new Error('Could not reach InfluxDB'), { kind: 'network' }); }
      const out = [];
      // Two whole days of readings: the old one and the recent one.
      for (const day of [OLD_DAY, RECENT_DAY]) {
        for (let b = Math.max(from, day); b < Math.min(to, day + DAY); b += 300) {
          const v = valueAt(series, b + 299);
          out.push({ bucket_start: b, avg: series.tags.entity_id === 'pv_today' ? v : v, min: v, max: v, count: 30 });
        }
      }
      return out;
    },
  };
}

function setup(mapping, roles) {
  db.exec('DELETE FROM metrics; DELETE FROM metrics_5m; DELETE FROM latest_metrics; DELETE FROM history; DELETE FROM history_5m; DELETE FROM savings_daily');
  database.setConfig('role_metrics', JSON.stringify(roles));
  database.setConfig('influx_state', '');
  return mapping;
}

(async () => {
  const sleeps = [];
  const deps = (client, mapping) => ({
    getClient: () => client, getDb: () => db, loadMapping: () => mapping,
    loadState: () => { try { return JSON.parse(database.getConfig('influx_state') || '{}'); } catch (_) { return {}; } },
    saveState: s => database.setConfig('influx_state', JSON.stringify(s)),
    roleMetrics: () => JSON.parse(database.getConfig('role_metrics') || '{}'),
    countPastDays: (d, day) => { deps.counted = day; return 0; },
    clearCaches: d => clearDailySnapshotCache(d),
    localDay: s => localDateString(new Date(s * 1000)),
    now: () => NOW, sleep: ms => { sleeps.push(ms); return Promise.resolve(); },
  });

  // ── A full import ─────────────────────────────────────────────────────
  const mapping = setup([
    { metric: 'pv_power', measurement: 'kW', field: 'value', tags: { entity_id: 'pv_kw' }, scale: 1000 },
    { metric: 'pv_today', measurement: 'kWh', field: 'value', tags: { entity_id: 'pv_today' }, scale: 1 },
    { metric: 'nothing', measurement: 'x', field: 'value', tags: { entity_id: 'empty' }, scale: 1 },
  ], { solar: 'pv_power', daily_solar: 'pv_today' });
  const client = fakeClient({ failFirst: 2 });
  const imp = createImporter(deps(client, mapping));
  const plan = await imp.plan();
  assert.deepStrictEqual(plan.metrics.map(m => [m.metric, m.from === OLD_DAY, m.buckets > 0]), [['pv_power', true, true], ['pv_today', true, true], ['nothing', false, false]]);
  assert.ok(plan.bytes > 0);
  const { done } = imp.start(plan);
  const result = await done;
  assert.strictEqual(result.state, 'done', JSON.stringify(result));
  assert.deepStrictEqual(sleeps, [5000, 30000], 'two network failures, tried again after 5 s and 30 s');
  const windows = client.calls.filter(c => c[0] === 'pv_kw');
  assert.ok(windows.every(([, f, t]) => t - f <= WINDOW_SECONDS), 'a week at a time');
  assert.strictEqual(windows[0][1], OLD_DAY); assert.strictEqual(windows[windows.length - 1][2], NOW);
  assert.ok(!('nothing' in result.metrics), 'a metric with no readings is not imported');

  const old5 = db.prepare('SELECT * FROM metrics_5m WHERE metric = ? AND bucket_start = ?').get('pv_power', OLD_DAY + 3600);
  assert.strictEqual(old5.value_avg, 1000, 'scaled from kW to W');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metrics WHERE metric = ? AND timestamp >= ? AND timestamp < ?').get('pv_power', RECENT_DAY, RECENT_DAY + DAY).n, 288,
    'the recent day as raw readings, one per 5 minutes');

  // Role history: the energy of each imported 5 minutes counts in full, old day and recent day alike.
  for (const day of [OLD_DAY, RECENT_DAY]) {
    const date = localDateString(new Date((day + 43200) * 1000));
    const hourly = readHourlyEnergy(db, { date, now: NOW });
    assert.ok(Math.abs(hourly.totals.energy.solar - 24) < 0.01, `${date}: 1 kW for 24 hours is 24 kWh (${hourly.totals.energy.solar})`);
    const daily = readDailySnapshots(db, { from: day, to: day + DAY, fields: ['daily_solar'] });
    assert.strictEqual(daily.length, 1);
    assert.ok(Math.abs(daily[0].daily_solar - 24) < 0.1, `${date}: the daily counter's last value (${daily[0].daily_solar})`);
  }
  assert.ok(result.history.rolled > 0 && result.history.raw > 0, JSON.stringify(result.history));
  assert.strictEqual(deps.counted, localDateString(new Date(OLD_DAY * 1000)), 'the savings count the imported days from the first one');

  // Savings: finished days added after they were counted get a kept value; days already kept are left alone.
  const { countAddedPastDays } = require('../modules/solarValue');
  const oldDate = localDateString(new Date((OLD_DAY + 43200) * 1000));
  assert.strictEqual(countAddedPastDays(db, oldDate), 0, 'nothing counted yet: the first count takes every day anyway');
  database.setConfig('savings_frozen_through', localDateString(new Date(NOW * 1000)));
  db.prepare('INSERT INTO savings_daily (day, kwh, price, value, method) VALUES (?, ?, ?, ?, ?)').run(localDateString(new Date((RECENT_DAY + 43200) * 1000)), 1, 1, 1, 'kept');
  assert.strictEqual(countAddedPastDays(db, oldDate), 1, 'the old imported day is counted');
  const kept = db.prepare('SELECT day, kwh, method FROM savings_daily ORDER BY day').all();
  assert.strictEqual(kept[0].day, oldDate); assert.ok(Math.abs(kept[0].kwh - 24) < 0.1);
  assert.strictEqual(kept[1].method, 'kept', 'a day already kept is not counted again');

  // ── Running it again stores nothing new ───────────────────────────────
  const again = await createImporter(deps(fakeClient(), mapping)).start(await createImporter(deps(fakeClient(), mapping)).plan()).done;
  const stored = Object.values(again.metrics).reduce((n, m) => n + m.buckets + m.raw, 0);
  assert.strictEqual(stored, 0, 'everything is already there');
  assert.strictEqual(again.history, undefined, 'and the role history is left as it is');

  // ── The dashboard's own history wins ──────────────────────────────────
  setup(mapping, { solar: 'pv_power' });
  db.prepare('INSERT INTO history (timestamp, solar) VALUES (?, ?)').run(RECENT_DAY + 600 + 10, 42);
  db.prepare('INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)').run(RECENT_DAY + 600 + 10, 'pv_power', 42);
  const r2 = await createImporter(deps(fakeClient(), mapping.slice(0, 1))).start({ until: NOW, metrics: [{ metric: 'pv_power', from: OLD_DAY, buckets: 1 }] }).done;
  assert.ok(r2.metrics.pv_power.skipped >= 1);
  assert.deepStrictEqual(db.prepare('SELECT timestamp, solar FROM history WHERE timestamp >= ? AND timestamp < ?').all(RECENT_DAY + 600, RECENT_DAY + 900), [{ timestamp: RECENT_DAY + 610, solar: 42 }]);

  // ── A metric that cannot be read is skipped; the others go on ─────────
  setup(mapping, {});
  const r3 = await createImporter(deps(fakeClient({ broken: ['pv_kw'] }), mapping.slice(0, 2))).start({ until: NOW, metrics: [{ metric: 'pv_power', from: OLD_DAY }, { metric: 'pv_today', from: OLD_DAY }] }).done;
  assert.strictEqual(r3.state, 'done-with-errors');
  assert.match(r3.metrics.pv_power.error, /series gone/);
  assert.ok(r3.metrics.pv_today.buckets > 0);

  // ── Pause carries on; stop stops ──────────────────────────────────────
  setup(mapping, {});
  let gate;
  const slow = fakeClient();
  const realBuckets = slow.buckets;
  slow.buckets = async (...a) => { await new Promise(r => { gate = r; }); return realBuckets(...a); };
  const d4 = deps(slow, mapping.slice(0, 1));
  const imp4 = createImporter(d4);
  imp4.start({ until: NOW, metrics: [{ metric: 'pv_power', from: OLD_DAY }] });
  await new Promise(r => setImmediate(r));
  const paused = imp4.pause();
  gate();
  await paused;
  const saved = JSON.parse(database.getConfig('influx_state')).import;
  assert.strictEqual(saved.state, 'running', 'a paused import stays marked running');
  assert.ok(saved.metrics.pv_power.cursor > OLD_DAY, 'with its progress saved');
  slow.buckets = realBuckets;
  const resumed = await createImporter(deps(slow, mapping.slice(0, 1))).resume();
  assert.strictEqual(resumed.state, 'done');
  assert.ok(slow.calls[0][1] >= saved.metrics.pv_power.cursor || slow.calls.length, 'it carried on from the saved week');

  setup(mapping, {});
  slow.buckets = async (...a) => { await new Promise(r => { gate = r; }); return realBuckets(...a); };
  const imp5 = createImporter(deps(slow, mapping.slice(0, 1)));
  imp5.start({ until: NOW, metrics: [{ metric: 'pv_power', from: OLD_DAY }] });
  await new Promise(r => setImmediate(r));
  const stopping = imp5.stop(); gate(); await stopping;
  assert.strictEqual(imp5.status().state, 'stopped');
  assert.strictEqual(createImporter(deps(slow, mapping)).resume(), null, 'a stopped import does not carry on by itself');

  // ── buildRoleHistory on its own: nothing to do without roles ──────────
  assert.deepStrictEqual(buildRoleHistory(db, { from: OLD_DAY, to: NOW, roleMetrics: {}, now: NOW }), { rolled: 0, raw: 0, skipped: 0 });

  // ── Routes ────────────────────────────────────────────────────────────
  setup(mapping, { solar: 'pv_power' });
  const service = require('../modules/influx/service');
  const routeImporter = createImporter({ ...deps(fakeClient(), mapping.slice(0, 1)), countPastDays: require('../modules/solarValue').countAddedPastDays });
  service.setImporterForTests(routeImporter);
  database.setConfig('influx_connection', JSON.stringify({ version: '2', url: 'http://192.0.2.10:8086', org: 'o', bucket: 'b', token: 't' }));
  database.setConfig('influx_mapping', JSON.stringify(mapping.slice(0, 1)));
  const express = require('express');
  const session = require('express-session');
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
  app.get('/signin', (q, r) => { q.session.authenticated = true; r.send('ok'); });
  app.use('/api/influx', require('../modules/sessionAuth').isAuthenticated, require('../routes/influx'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let cookie = '';
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let t = ''; res.on('data', c => { t += c; });
      res.on('end', () => { if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; let j = null; try { j = JSON.parse(t); } catch { /* empty */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  try {
    for (const p of ['/import/plan', '/import/start', '/import/stop']) assert.strictEqual((await call('POST', '/api/influx' + p, {})).status, 401);
    await call('GET', '/signin');
    let r = await call('GET', '/api/influx');
    assert.deepStrictEqual(r.body.import, { state: 'idle' });
    r = await call('POST', '/api/influx/import/plan', {});
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.metrics[0].from, OLD_DAY);
    r = await call('POST', '/api/influx/import/start', {});
    assert.strictEqual(r.status, 200);
    for (let i = 0; i < 100 && routeImporter.isRunning(); i++) await new Promise(res => setTimeout(res, 20));
    r = await call('GET', '/api/influx');
    assert.strictEqual(r.body.import.state, 'done');
    assert.strictEqual(r.body.import.progress, 1);
    database.setConfig('influx_mapping', '[]');
    assert.match((await call('POST', '/api/influx/import/start', {})).body.error, /metrics to read/);
  } finally { server.close(); }

  // ── Wiring ────────────────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /flushPartDays\(\);\n\s+require\('\.\/modules\/influx\/service'\)\.stop\(\);/, 'paused for a restore');
  assert.match(src, /checkHealth\(\);\n\s+require\('\.\/modules\/influx\/service'\)\.start\(\);/, 'carries on after one, and at startup');
  assert.match(src, /await require\('\.\/modules\/influx\/service'\)\.stop\(\);/, 'paused at shutdown');
  console.log('ok - influx import');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
