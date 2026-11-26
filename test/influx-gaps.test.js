'use strict';
const checks = require('./_checks');
/**
 * Filling gaps (modules/influx/service.js fillGaps): nothing before the user's first import; after it, the time since the
 * import (or the last fill), less an hour of overlap, is read again; only the holes in the dashboard's own readings are
 * filled; the import's status is left as the user's; the next fill starts where this one ended; and the service schedules
 * it at startup and stops it for a restore.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-influx-gaps-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const { createImporter } = require('../modules/influx/importer');
const service = require('../modules/influx/service');

const NOW = Math.floor(Date.now() / 1000 / 300) * 300;
const asked = [];
const client = {
  async first() { throw new Error('a fill of gaps never asks for first readings'); },
  async buckets(series, from, to) {
    asked.push([from, to]);
    const out = [];
    for (let b = from; b < to; b += 300) out.push({ bucket_start: b, avg: 100, min: 100, max: 100, count: 10 });
    return out;
  },
};
const deps = {
  stateKey: 'gap', getClient: () => client, getDb: () => db, loadMapping: () => [{ metric: 'pv', measurement: 'W', field: 'value', tags: { entity_id: 'pv' }, scale: 1 }],
  loadState: service.loadState, saveState: service.saveState, roleMetrics: () => ({}), now: () => NOW,
};

(async () => {
  // The plan of a fill: every metric from the given time, no first-reading queries.
  const p = await createImporter(deps).plan({ since: NOW - 3600 - 17 });
  assert.deepStrictEqual(p.metrics, [{ metric: 'pv', from: NOW - 3900, buckets: 13 }]);

  database.setConfig('influx_connection', JSON.stringify({ version: '2', url: 'http://192.0.2.10:8086', org: 'o', bucket: 'b', token: 't' }));
  database.setConfig('influx_mapping', JSON.stringify(deps.loadMapping()));
  service.setImporterForTests({ isRunning: () => false });
  service.setGapImporterForTests(createImporter(deps));

  service.saveState({ connectedAt: NOW - 86400 });
  assert.strictEqual(await service.fillGaps(NOW), null, 'never imported: nothing to fill');

  // Imported up to 6 hours ago; the dashboard has its own readings since, except for one hour.
  const importUntil = NOW - 6 * 3600;
  const importStatus = { state: 'done', until: importUntil, metrics: { pv: { from: NOW - 86400, cursor: importUntil, done: true, buckets: 1, raw: 0, skipped: 0 } } };
  service.saveState({ connectedAt: NOW - 86400, import: importStatus });
  const hole = [NOW - 3 * 3600, NOW - 2 * 3600];
  const ins = db.prepare('INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  for (let t = importUntil - 3600; t < NOW; t += 60) if (t < hole[0] || t >= hole[1]) ins.run(t, 'pv', 5);

  const result = await service.fillGaps(NOW);
  assert.strictEqual(result.state, 'done');
  assert.strictEqual(asked[0][0], importUntil - 3600, 'from an hour before the import ended');
  assert.strictEqual(asked[asked.length - 1][1], NOW);
  assert.strictEqual(result.metrics.pv.raw, 12, 'only the hour with no readings is filled (12 periods of 5 minutes)');
  const filled = db.prepare('SELECT COUNT(*) n FROM metrics WHERE metric = ? AND value = 100').get('pv').n;
  assert.strictEqual(filled, 12);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metrics WHERE metric = ? AND value = 100 AND (timestamp < ? OR timestamp >= ?)').get('pv', ...hole).n, 0, 'nothing outside the hole');
  const state = service.loadState();
  assert.deepStrictEqual(state.import, importStatus, 'the import\'s status is the user\'s, untouched');
  assert.strictEqual(state.syncedThrough, NOW);
  assert.strictEqual(state.gap.state, 'done');

  assert.strictEqual(await service.fillGaps(NOW + 600), null, 'less than 15 minutes later: nothing to do');
  asked.length = 0;
  const again = await service.fillGaps(NOW + 3600);
  assert.ok(again, 'an hour later it runs again');
  assert.strictEqual(asked[0][0], NOW - 3600, 'from an hour before the last fill ended');

  service.setImporterForTests({ isRunning: () => true });
  assert.strictEqual(await service.fillGaps(NOW + 7200), null, 'not while the user\'s import runs');

  // Wiring.
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'influx', 'service.js'), 'utf8');
  assert.match(src, /if \(!gapTimers\.length\) scheduleGaps\(\)/, 'scheduled at startup and after a restore');
  assert.match(src, /for \(const t of gapTimers\) \{ clearTimeout\(t\); clearInterval\(t\); \}/, 'and stopped for one');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'influx.js'), 'utf8'), /await service\.getGapImporter\(\)\.stop\(\);/, 'the user\'s import stops a fill');
  console.log('ok - influx gaps');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
