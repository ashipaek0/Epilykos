'use strict';
const checks = require('./_checks');
/**
 * modules/influx/writer.js against a fake InfluxDB 2.x and 1.x: readings from the connection's first save on, numbers only,
 * mapped metrics only unless "every reading"; the newest seconds left for the next round; big catch-ups in batches with
 * nothing lost or sent twice at a batch edge; a failing InfluxDB waited out and caught up; a malformed batch passed over;
 * a new writer (a restart) carrying on from the saved position; the status the page shows.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-influx-writer-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const { createWriter, BATCH, LAG_SECONDS } = require('../modules/influx/writer');
const { createInfluxClient } = require('../modules/influx/client');
const { createFakeInflux, directFetch } = require('./_fake-influx');

const T0 = 1_790_000_000;
let clock = T0 + 3600, clockMs = clock * 1000;
const insert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value, value_text, value_type) VALUES (?, ?, ?, ?, ?)');

(async () => {
  for (const version of ['2', '1']) {
    db.exec('DELETE FROM metrics');
    database.setConfig('influx_state', JSON.stringify({ connectedAt: T0 }));
    const fake = createFakeInflux(version === '2' ? { version: '2', token: 'tok' } : { version: '1' });
    const url = await fake.listen();
    const conn = version === '2' ? { version: '2', url, org: 'o', bucket: 'b', token: 'tok' } : { version: '1', url, database: 'home' };
    let write = { measurement: 'epilykos', all: false };
    let mapped = ['pv', 'load'];
    let connected = true;
    const warnings = [];
    const deps = () => ({
      getClient: () => (connected ? createInfluxClient(conn, { fetchImpl: directFetch }) : null),
      getDb: () => db, loadWrite: () => write, mappedMetrics: () => mapped,
      loadState: () => JSON.parse(database.getConfig('influx_state') || '{}'),
      saveState: s => database.setConfig('influx_state', JSON.stringify(s)),
      now: () => clock, nowMs: () => clockMs, log: { info() {}, warn: m => warnings.push(m) },
    });
    const w = createWriter(deps());

    insert.run(T0 - 60, 'pv', 1, null, null);                 // before the connection: never written
    insert.run(T0 + 10, 'pv', 500.5, null, null);
    insert.run(T0 + 10, 'load', 300, null, null);
    insert.run(T0 + 10, 'other', 7, null, null);              // not mapped
    insert.run(T0 + 20, 'pv', null, 'on', 'boolean');         // not a number
    insert.run(clock - LAG_SECONDS + 25, 'pv', 9, null, null); // too new: next round
    assert.strictEqual(await w.round(), 2, `${version}: two points`);
    assert.deepStrictEqual(fake.written, [`epilykos,metric=load value=300 ${T0 + 10}`, `epilykos,metric=pv value=500.5 ${T0 + 10}`]);
    const st = w.status();
    assert.deepStrictEqual([st.state, st.written, st.through], ['ok', 2, T0 + 20], 'past the text reading too');
    clock += LAG_SECONDS; clockMs = clock * 1000;
    assert.strictEqual(await w.round(), 1, 'the newest reading goes in the next round');

    // Every reading, into another measurement.
    write = { measurement: 'mine', all: true };
    insert.run(clock - LAG_SECONDS - 1, 'other', 8, null, null);
    fake.written.length = 0;
    assert.strictEqual(await w.round(), 1);
    assert.deepStrictEqual(fake.written, [`mine,metric=other value=8 ${clock - LAG_SECONDS - 1}`]);

    // A catch-up bigger than a batch, with many readings at the same second across the batch edge.
    db.exec('DELETE FROM metrics');
    const base = clock + 1000;
    const many = db.transaction(() => { for (let i = 0; i < BATCH * 2 + 123; i++) insert.run(base + Math.floor(i / 1000), `m${String(i % 1000).padStart(4, '0')}`, i, null, null); });
    many();
    clock = base + LAG_SECONDS + 100; clockMs = clock * 1000;
    fake.written.length = 0;
    assert.strictEqual(await w.round(), BATCH * 2 + 123, 'all of it in one round');
    assert.strictEqual(new Set(fake.written).size, BATCH * 2 + 123, 'none twice');
    assert.ok(fake.log.filter(e => e.path.endsWith('write')).length >= 3, 'in batches');

    // InfluxDB down: waited out, then caught up.
    insert.run(clock - LAG_SECONDS - 60, 'pv', 1, null, null);
    insert.run(clock - LAG_SECONDS - 50, 'pv', 2, null, null);
    fake.state.failWrites = 2; fake.state.writeStatus = 503;
    fake.written.length = 0;
    assert.strictEqual(await w.round(), 0);
    assert.strictEqual(w.status().state, 'error');
    assert.match(w.status().lastError, /unavailable/);
    assert.strictEqual(await w.round(), 0, 'not asked again before the wait is over');
    clockMs += 10_000;
    assert.strictEqual(await w.round(), 0, 'failed again');
    clockMs += 15_000;
    assert.strictEqual(await w.round(), 0, 'the wait doubled: 20 s');
    clockMs += 10_000;
    assert.strictEqual(await w.round(), 2, 'caught up');
    assert.strictEqual(w.status().state, 'ok');

    // A malformed batch is passed over.
    insert.run(clock - LAG_SECONDS - 45, 'pv', 3, null, null);
    fake.state.failWrites = 1; fake.state.writeStatus = 400;
    assert.strictEqual(await w.round(), 1, 'counted as gone past');
    assert.match(w.status().lastError, /unavailable/);
    insert.run(clock - LAG_SECONDS - 44, 'pv', 4, null, null);
    fake.written.length = 0;
    await w.round();
    assert.deepStrictEqual(fake.written, [`mine,metric=pv value=4 ${clock - LAG_SECONDS - 44}`], 'and the next one goes');

    // A restart carries on from the saved position.
    insert.run(clock - LAG_SECONDS - 40, 'pv', 5, null, null);
    fake.written.length = 0;
    const w2 = createWriter(deps());
    assert.strictEqual(await w2.round(), 1);
    assert.deepStrictEqual(fake.written, [`mine,metric=pv value=5 ${clock - LAG_SECONDS - 40}`]);

    // No connection, or nothing chosen: off and idle.
    connected = false;
    assert.strictEqual(await w2.round(), 0); assert.strictEqual(w2.status().state, 'off');
    connected = true; write = { measurement: 'epilykos', all: false }; mapped = [];
    assert.strictEqual(await w2.round(), 0); assert.strictEqual(w2.status().state, 'idle');
    database.setConfig('influx_state', '{}');
    mapped = ['pv'];
    insert.run(clock - LAG_SECONDS - 30, 'pv', 6, null, null);
    fake.written.length = 0;
    assert.strictEqual(await w2.round(), 0, 'a connection saved without its first save recorded: written from now on, not from the past');
    assert.strictEqual(JSON.parse(database.getConfig('influx_state')).connectedAt, clock);
    await fake.close();
  }

  // A restore while a round waits on InfluxDB: the new database's position is left alone.
  database.setConfig('influx_state', JSON.stringify({ connectedAt: T0 }));
  db.exec('DELETE FROM metrics');
  insert.run(T0 + 5, 'pv', 1, null, null);
  let current = true;
  const w3 = createWriter({
    getClient: () => ({ write: async () => { current = false; } }), getDb: () => db, loadWrite: () => ({ measurement: 'e', all: true }), mappedMetrics: () => [],
    loadState: () => JSON.parse(database.getConfig('influx_state') || '{}'), saveState: s => database.setConfig('influx_state', JSON.stringify(s)),
    isCurrent: () => current, now: () => T0 + 3600, nowMs: () => (T0 + 3600) * 1000,
  });
  await w3.round();
  assert.deepStrictEqual(JSON.parse(database.getConfig('influx_state')), { connectedAt: T0 });

  // Wiring: the service starts the writer and the page shows its status.
  const service = fs.readFileSync(path.join(__dirname, '..', 'modules', 'influx', 'service.js'), 'utf8');
  assert.match(service, /getWriter\(\)\.start\(\)/); assert.match(service, /writer\.stop\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'influx.js'), 'utf8'), /writing: service\.getWriter\(\)\.status\(\)/);
  console.log('ok - influx writer');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
