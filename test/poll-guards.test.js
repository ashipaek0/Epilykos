'use strict';
const checks = require('./_checks');
// Server-side guards found in review: one dongle poll at a time, state of
// deleted combined metrics removed, deleting a metric tidies its roles.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-guards-'));
process.chdir(tmp);
const database = require('../modules/database');
database.initializeDatabase();

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

(async () => {
  await check('dongle: a poll still running makes the next tick a no-op instead of queueing', async () => {
    const { singleFlight } = require('../modules/dongle');
    let calls = 0, release;
    const inst = { name: 'Phocos 1' };
    const poll = singleFlight(inst, () => { calls++; return new Promise(r => { release = r; }); });
    const first = poll(); poll(); poll();
    await new Promise(r => setImmediate(r));   // the poll starts on the next tick
    assert.strictEqual(calls, 1, 'two ticks skipped while the first poll runs');
    assert.strictEqual(inst._skippedPolls, 2);
    release(); await first;
    await new Promise(r => setImmediate(r));
    const second = poll(); await new Promise(r => setImmediate(r));
    assert.strictEqual(calls, 2, 'runs again once the first finished');
    release(); await second;
    const failing = singleFlight({ name: 'x' }, () => { throw new Error('boom'); });
    await failing();   // a failing poll is logged, never an unhandled rejection
  });

  await check('dongle: a Bluetooth unit that keeps failing is polled less often, and every tick again once it answers', async () => {
    const { singleFlight, withBleBackoff } = require('../modules/dongle');
    // Like pollJsonInstance: catches its own error and counts it.
    let calls = 0, ok = false;
    const inst = { name: 'Inverter 2' };
    const read = async () => { calls++; if (ok) inst.consecutiveFails = 0; else inst.consecutiveFails = (inst.consecutiveFails || 0) + 1; };
    const poll = singleFlight(inst, withBleBackoff(inst, read));
    const ticks = async n => { for (let i = 0; i < n; i++) await poll(); };
    await ticks(3); assert.strictEqual(calls, 3, 'the first failures poll every tick');
    await ticks(2); assert.strictEqual(calls, 4, 'after 3 failures: 1 tick skipped');
    await ticks(4); assert.strictEqual(calls, 5, 'then 3 skipped');
    await ticks(80);
    const before = calls; await ticks(16); assert.strictEqual(calls - before, 2, 'capped at 7 skipped ticks');
    ok = true;
    for (let i = 0; i < 8 && calls === before + 2; i++) await poll();   // the next attempt succeeds
    const recovered = calls; await ticks(3); assert.strictEqual(calls - recovered, 3, 'every tick again after a success');
    // A poll that throws instead of counting is treated the same way.
    const thrower = { name: 'x' }; let n = 0;
    const p2 = singleFlight(thrower, withBleBackoff(thrower, () => { n++; throw new Error('boom'); }));
    for (let i = 0; i < 5; i++) await p2();
    assert.strictEqual(n, 4); assert.strictEqual(thrower.consecutiveFails, 4);
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'dongle.js'), 'utf8');
    assert.match(src, /singleFlight\(inst, withBleBackoff\(inst, \(\) => pollJsonInstance/, 'Phocos and other GATT units');
    assert.match(src, /inst\.transport === 'ble-modbus' \? withBleBackoff/);
    assert.match(src, /inst\.transport === 'ble-luxpower' \? withBleBackoff/);
  });

  await check('combined metrics: state of a deleted definition is removed, switched-off ones keep theirs', () => {
    const cm = require('../modules/combinedMetrics');
    database.setConfig('combined_metrics', JSON.stringify([{ id: 'keep', name: 'k', fn: 'sum', inputs: ['a'], enabled: false }]));
    database.setConfig('combined_metrics_state', JSON.stringify({ keep: { kwh: 1 }, gone: { kwh: 2 }, 'gone#parts': {} }));
    database.getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run('a', 1, Math.floor(Date.now() / 1000));
    database.setConfig('combined_metrics', JSON.stringify([{ id: 'keep', name: 'k', fn: 'sum', inputs: ['a'], enabled: false }, { id: 'on', name: 'o', fn: 'sum', inputs: ['a'] }]));
    cm.runCombinedMetrics();
    assert.ok('gone' in JSON.parse(database.getConfig('combined_metrics_state')), 'not in the poll loop any more');
    assert.strictEqual(cm.pruneState(), true);   // runs when definitions are saved
    assert.deepStrictEqual(Object.keys(JSON.parse(database.getConfig('combined_metrics_state'))).sort(), ['keep']);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /cm\.pruneState\(clean\)/);
  });

  await check('per-part daily kWh is buffered (written every few minutes, at a new day, and before tables read it)', () => {
    const cm = require('../modules/combinedMetrics');
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'combinedMetrics.js'), 'utf8');
    assert.match(src, /if \(dayChanged \|\| Date\.now\(\) - lastPartWrite >= PART_WRITE_MS\) flushPartDays\(\);/);
    assert.match(src, /function partDays\(fromDay, toDay\) \{\n  try \{ flushPartDays\(\); \}/);
    assert.strictEqual(cm.staleSecondsOf({}), 300); assert.strictEqual(cm.staleSecondsOf({ stale_seconds: 60 }), 60);
    assert.strictEqual((src.match(/stale_seconds\) >= 10 \? /g) || []).length, 1, 'one default stale rule');
    const dongle = fs.readFileSync(path.join(__dirname, '..', 'modules', 'dongle.js'), 'utf8');
    assert.doesNotMatch(dongle, /singleFlight\(inst, \(\) => pollLuxpowerInstance/, 'LuxPower keeps its own guard only');
  });

  await check('rate limit, delete tidy-up and combined refusal are in the routes', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(srv, /rolesCleared\.forEach\(r => \{ roles\[r\] = ''; \}\)/);
    assert.match(srv, /return res\.status\(409\)\.json\(\{ error: `\$\{name\} is a combined metric/);
  });

  assert.strictEqual(passed, 5, 'every check ran');
  console.log(`poll-guards: ${passed} checks passed`);
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
