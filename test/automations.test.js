'use strict';
const checks = require('./_checks');
/**
 * Control automations (modules/automations): validation, condition
 * evaluation, the engine on a fake clock with fake devices, storage, and the
 * executor against the real dispatch with faked transports.
 * - stale or missing data decides nothing, and nothing is sent;
 * - a change is sent only when the target is not already as wanted, and
 *   retried when the device does not follow, then given up with an alert;
 * - several steps run in order and stop at the first that fails;
 * - "for how long", margins, time windows (across midnight, weekdays);
 * - "pause all" stops everything; only listed settings are offered.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-automations-'));
process.chdir(tmp);
process.env.SETTINGS_PASSWORD = 'made-up-test-password';
const database = require('../modules/database');
database.initializeDatabase();
const { validateDefinition } = require('../modules/automations/definition');
const { evaluateConditions } = require('../modules/automations/evaluate');
const { createEngine } = require('../modules/automations/engine');
const store = require('../modules/automations/store');
const executor = require('../modules/automations/executor');
const catalogMod = require('../modules/automations/catalog');
const deviceActions = require('../modules/deviceActions');
const controls = require('../modules/deviceControls');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);   // a Tuesday, 10:00 UTC (the test run's local zone may differ; time tests use local getters)
const localAt = (h, m, day) => { const d = new Date(2026, 10, 24 + (day === undefined ? 0 : day - new Date(2026, 10, 24).getDay()), h, m, 0); return d.getTime(); };

const CATALOG = [
  { key: 'tuya|Geyser|relay', source: 'tuya', device: 'Geyser', entity: 'relay', label: 'relay (DP 1)', kind: 'value', ops: ['on', 'off', 'set'], metric: 'relay' },
  { key: 'device|Lux|charge_amps', source: 'device', device: 'Lux', entity: 'charge_amps', label: 'Charge current', kind: 'number', ops: ['set'], min: 2, max: 100, step: 1, metric: '', deviceKind: 'dongle' },
  { key: 'device|Lux|grid_charge', source: 'device', device: 'Lux', entity: 'grid_charge', label: 'Grid charge', kind: 'switch', ops: ['on', 'off'], metric: '', deviceKind: 'dongle' },
  { key: 'device|Lux|mode', source: 'device', device: 'Lux', entity: 'mode', label: 'Mode', kind: 'select', ops: ['set'], options: [{ value: '0', label: 'A' }, { value: '2', label: 'B' }], metric: '', deviceKind: 'dongle' },
];
const tuya = { source: 'tuya', device: 'Geyser', entity: 'relay' };
const dev = e => ({ source: 'device', device: 'Lux', entity: e });
const base = over => ({ name: 'Geyser on sun', enabled: true, when: [{ type: 'metric', metric: 'battery_soc', operator: 'gt', value: 90 }], then: [{ target: tuya, op: 'on' }], ...over });

(async () => {
  await check('validation: cleans a definition and explains every problem', () => {
    let v = validateDefinition(base({ for_s: '120', else: [{ target: tuya, op: 'off' }] }), CATALOG);
    assert.ok(v.ok, v.errors.join()); assert.strictEqual(v.def.for_s, 120); assert.strictEqual(v.def.max_age_s, 900); assert.strictEqual(v.def.join, 'all');
    v = validateDefinition({ name: '', when: [], then: [] }, CATALOG);
    assert.ok(!v.ok); assert.ok(v.errors.length >= 3); assert.strictEqual(v.def, null);
    for (const [bad, re] of [
      [base({ then: [{ target: dev('charge_amps'), op: 'set', value: 500 }] }), /between 2 and 100/],
      [base({ then: [{ target: dev('charge_amps'), op: 'set', value: 2.5 }] }), /steps of 1/],
      [base({ then: [{ target: dev('charge_amps'), op: 'on' }] }), /cannot be turned on/],
      [base({ then: [{ target: dev('mode'), op: 'set', value: 7 }] }), /listed values/],
      [base({ then: [{ target: { source: 'dongle', device: 'Lux', entity: '0x69' }, op: 'set', value: 1 }] }), /not available/],
      [base({ when: [{ type: 'metric', metric: 'x', operator: 'gt', value: 'abc' }] }), /must be a number/],
      [base({ when: [{ type: 'time', from: '25:00', to: '06:00' }] }), /times like/],
      [base({ for_s: 999999 }), /For how long/],
    ]) { const r = validateDefinition(bad, CATALOG); assert.ok(!r.ok); assert.match(r.errors.join(' '), re); }
    v = validateDefinition(base({ then: [{ target: dev('grid_charge'), op: 'on' }, { target: dev('charge_amps'), op: 'set', value: '40' }, { target: dev('mode'), op: 'set', value: '2' }] }), CATALOG);
    assert.ok(v.ok); assert.deepStrictEqual(v.def.then.map(s => s.value), [undefined, 40, 2]);
  });

  await check('evaluation: stale or missing data is unknown, margins and any/all', () => {
    const def = validateDefinition(base({ when: [{ type: 'metric', metric: 'battery_soc', operator: 'gt', value: 90, hysteresis: 5 }] }), CATALOG).def;
    const m = (value, ageS = 10) => ({ battery_soc: { value, timestamp: T0 - ageS * 1000 } });
    assert.strictEqual(evaluateConditions(def, m(91), T0, false).met, true);
    assert.strictEqual(evaluateConditions(def, m(88), T0, false).met, false);
    assert.strictEqual(evaluateConditions(def, m(88), T0, true).met, true, 'inside the margin once active');
    assert.strictEqual(evaluateConditions(def, m(84), T0, true).met, false);
    assert.strictEqual(evaluateConditions(def, m(95, 3600), T0, false).met, null, 'an hour old is unknown');
    assert.match(evaluateConditions(def, m(95, 3600), T0, false).parts[0].reason, /not updated/);
    assert.strictEqual(evaluateConditions(def, {}, T0, false).met, null);
    assert.strictEqual(evaluateConditions(def, m('n/a'), T0, false).met, null);
    const two = validateDefinition(base({ join: 'any', when: [{ type: 'metric', metric: 'battery_soc', operator: 'gt', value: 90 }, { type: 'metric', metric: 'pv', operator: 'gt', value: 1000 }] }), CATALOG).def;
    assert.strictEqual(evaluateConditions(two, { battery_soc: { value: 95, timestamp: T0 } }, T0, false).met, true, 'any: one true is enough, the other unknown');
    assert.strictEqual(evaluateConditions({ ...two, join: 'all' }, { battery_soc: { value: 95, timestamp: T0 } }, T0, false).met, null, 'all: unknown decides nothing');
    assert.strictEqual(evaluateConditions({ ...two, join: 'all' }, { battery_soc: { value: 50, timestamp: T0 } }, T0, false).met, false, 'all: one false is false');
    const text = validateDefinition(base({ when: [{ type: 'metric', metric: 'Grid Status', operator: 'eq', value: 'off' }] }), CATALOG).def;
    assert.strictEqual(evaluateConditions(text, { 'Grid Status': { value: 'OFF', timestamp: T0 } }, T0, false).met, true);
  });

  await check('evaluation: time windows, across midnight, weekdays, unset clock', () => {
    const win = (from, to, days) => validateDefinition(base({ when: [{ type: 'time', from, to, days }] }), CATALOG).def;
    const at = (def, h, m, day) => evaluateConditions(def, {}, localAt(h, m, day), false).met;
    assert.strictEqual(at(win('09:00', '16:00'), 12, 0), true);
    assert.strictEqual(at(win('09:00', '16:00'), 16, 0), false);
    assert.strictEqual(at(win('22:00', '06:00'), 23, 30), true);
    assert.strictEqual(at(win('22:00', '06:00'), 5, 59), true);
    assert.strictEqual(at(win('22:00', '06:00'), 12, 0), false);
    const weekdays = win('09:00', '16:00', [1, 2, 3, 4, 5]);
    assert.strictEqual(at(weekdays, 12, 0, 6), false, 'Saturday');
    assert.strictEqual(at(weekdays, 12, 0, 3), true, 'Wednesday');
    const nightMon = win('22:00', '06:00', [1]);
    assert.strictEqual(at(nightMon, 3, 0, 2), true, 'Tuesday 03:00 belongs to the window that began Monday');
    assert.strictEqual(at(nightMon, 3, 0, 1), false);
    assert.strictEqual(evaluateConditions(win('09:00', '16:00'), {}, Date.UTC(2020, 0, 1, 12), false).met, null, 'a clock that was never set');
  });

  // ── engine on a fake clock with fake devices ──
  function rig(defs, opts = {}) {
    const r = { now: T0, metrics: {}, devices: {}, sent: [], runs: [], events: [], paused: false, sendFails: 0, followDevice: true, autos: [] };
    r.autos = defs.map((d, i) => { const v = validateDefinition(d, CATALOG); assert.ok(v.ok, v.errors.join()); return { id: i + 1, ...v.def, updated_at: 1 }; });
    r.engine = createEngine({
      now: () => r.now, getMetrics: () => r.metrics, catalog: () => CATALOG, list: () => r.autos, paused: () => r.paused,
      readCurrent: async entry => (entry.entity in r.devices ? { value: r.devices[entry.entity] } : { error: 'unreadable' }),
      send: async (entry, step) => {
        r.sent.push([entry.entity, step.op, step.value]);
        if (r.sendFails > 0) { r.sendFails--; return { ok: false, error: 'offline' }; }
        const want = step.op === 'set' ? step.value : step.op === 'on';
        if (entry.source === 'device') { if (r.followDevice) r.devices[entry.entity] = want; }
        else if (r.followDevice) r.metrics[entry.metric] = { value: want ? 'on' : 'off', timestamp: r.now };
        return { ok: true };
      },
      logRun: x => r.runs.push(x), notify: (type, f) => r.events.push([type, f.subject]), error: (a, e) => { throw e; },
    });
    r.soc = v => { r.metrics.battery_soc = { value: v, timestamp: r.now }; };
    r.advance = s => { r.now += s * 1000; };
    return r;
  }

  await check('engine: sends only when needed, nothing on stale data, undoes with "otherwise"', async () => {
    const r = rig([base({ else: [{ target: tuya, op: 'off' }] })]);
    r.metrics.relay = { value: 'off', timestamp: r.now };
    r.soc(95); await r.engine.tick();
    assert.deepStrictEqual(r.sent, [['relay', 'on', undefined]]);
    r.advance(15); r.soc(95); await r.engine.tick();
    assert.strictEqual(r.sent.length, 1, 'already on: nothing more is sent');
    r.advance(3600);                                    // the reading is now an hour old
    await r.engine.tick();
    assert.strictEqual(r.sent.length, 1, 'stale data: nothing happens');
    r.soc(50); r.metrics.relay.timestamp = r.now; await r.engine.tick();
    assert.deepStrictEqual(r.sent[1], ['relay', 'off', undefined], 'conditions ended: otherwise branch');
    assert.deepStrictEqual(r.runs.map(x => [x.branch, x.outcome]), [['then', 'done'], ['else', 'done']]);
    assert.ok(r.events.some(e => e[0] === 'automation.ran'));
  });

  await check('engine: "for how long" and disabled automations', async () => {
    const r = rig([base({ for_s: 120 }), base({ name: 'Off', enabled: false })]);
    r.metrics.relay = { value: 'off', timestamp: r.now };
    r.soc(95); await r.engine.tick(); assert.strictEqual(r.sent.length, 0);
    r.advance(60); r.soc(95); r.metrics.relay.timestamp = r.now; await r.engine.tick(); assert.strictEqual(r.sent.length, 0);
    r.advance(61); r.soc(95); r.metrics.relay.timestamp = r.now; await r.engine.tick(); assert.strictEqual(r.sent.length, 1);
    const q = rig([base({ for_s: 120 })]); q.metrics.relay = { value: 'off', timestamp: q.now };
    q.soc(95); await q.engine.tick(); q.advance(60); q.soc(10); await q.engine.tick(); q.advance(70); q.soc(95); await q.engine.tick();
    assert.strictEqual(q.sent.length, 0, 'a dip restarts the wait');
  });

  await check('engine: a switch that does not follow is retried, then given up with an alert', async () => {
    const r = rig([base()]);
    r.followDevice = false; r.metrics.relay = { value: 'off', timestamp: r.now };
    for (let i = 0; i < 12; i++) { r.soc(95); r.metrics.relay.timestamp = r.now; await r.engine.tick(); r.advance(100); }
    assert.strictEqual(r.sent.length, 4, 'four attempts, then it stops');
    assert.ok(r.runs.some(x => x.outcome === 'failed' && /Gave up/.test(x.detail)) || r.events.some(e => e[0] === 'automation.failed'));
    const failed = r.events.filter(e => e[0] === 'automation.failed');
    assert.strictEqual(failed.length, 1, 'one alert, not a stream');
    r.soc(10); await r.engine.tick(); r.advance(15); r.soc(95); r.metrics.relay = { value: 'off', timestamp: r.now }; await r.engine.tick();
    assert.ok(r.sent.length > 4, 'a change of conditions tries again');
  });

  await check('engine: a failed send backs off and alerts once', async () => {
    const r = rig([base()]);
    r.metrics.relay = { value: 'off', timestamp: r.now }; r.sendFails = 2;
    r.soc(95); await r.engine.tick(); assert.strictEqual(r.sent.length, 1);
    r.advance(15); r.soc(95); r.metrics.relay.timestamp = r.now; await r.engine.tick(); assert.strictEqual(r.sent.length, 1, 'waits before retrying');
    r.advance(60); r.soc(95); r.metrics.relay.timestamp = r.now; await r.engine.tick(); assert.strictEqual(r.sent.length, 2);
    r.advance(130); r.soc(95); r.metrics.relay.timestamp = r.now; await r.engine.tick(); assert.strictEqual(r.sent.length, 3);
    assert.strictEqual(r.events.filter(e => e[0] === 'automation.failed').length, 1);
    assert.strictEqual(r.runs.filter(x => x.outcome === 'failed').length, 2);
  });

  await check('engine: several settings make one action, in order, stopping at the first failure', async () => {
    const steps = [{ target: dev('grid_charge'), op: 'on' }, { target: dev('charge_amps'), op: 'set', value: 100 }, { target: dev('mode'), op: 'set', value: 2 }];
    const r = rig([base({ then: steps, else: [{ target: dev('grid_charge'), op: 'off' }, { target: dev('charge_amps'), op: 'set', value: 2 }] })]);
    r.devices = { grid_charge: false, charge_amps: 2, mode: 0 };
    r.soc(95); await r.engine.tick();
    assert.deepStrictEqual(r.sent.map(s => s[0]), ['grid_charge', 'charge_amps', 'mode']);
    assert.deepStrictEqual(r.devices, { grid_charge: true, charge_amps: 100, mode: 2 });
    r.advance(15); r.soc(95); await r.engine.tick(); assert.strictEqual(r.sent.length, 3, 'all already as wanted');
    r.advance(15); r.soc(10); await r.engine.tick();
    assert.deepStrictEqual(r.sent.slice(3).map(s => s[0]), ['grid_charge', 'charge_amps'], 'and back again');
    assert.deepStrictEqual(r.devices, { grid_charge: false, charge_amps: 2, mode: 2 });
    const f = rig([base({ then: steps })]); f.devices = { grid_charge: false, charge_amps: 2, mode: 0 }; f.sendFails = 1;
    f.soc(95); await f.engine.tick();
    assert.deepStrictEqual(f.sent.map(s => s[0]), ['grid_charge'], 'the second setting waits for the first');
  });

  await check('engine: a drifted setting is put back; manual changes to unrelated settings are left alone', async () => {
    const r = rig([base({ then: [{ target: dev('charge_amps'), op: 'set', value: 50 }] })]);
    r.devices = { charge_amps: 50, mode: 0 };
    r.soc(95); await r.engine.tick(); assert.strictEqual(r.sent.length, 0);
    r.devices.charge_amps = 10; r.devices.mode = 2;
    r.advance(301); r.soc(95); await r.engine.tick();
    assert.deepStrictEqual(r.sent, [['charge_amps', 'set', 50]]);
    assert.strictEqual(r.devices.mode, 2);
  });

  await check('engine: pause all, busy ticks, edits, unreadable targets, dry run', async () => {
    const r = rig([base()]);
    r.metrics.relay = { value: 'off', timestamp: r.now }; r.soc(95);
    r.paused = true; assert.deepStrictEqual(await r.engine.tick(), { skipped: 'paused' }); assert.strictEqual(r.sent.length, 0);
    r.paused = false;
    const dry = await r.engine.dryRun(r.autos[0]);
    assert.strictEqual(dry.met, true); assert.deepStrictEqual(dry.steps.map(s => [s.wanted, s.wouldSend]), [['on', true]]); assert.strictEqual(r.sent.length, 0, 'a dry run never sends');
    const slow = rig([base()]); slow.metrics.relay = { value: 'off', timestamp: slow.now }; slow.soc(95);
    const first = slow.engine.tick(); assert.deepStrictEqual(await slow.engine.tick(), { skipped: 'busy' }); await first;
    const u = rig([base({ then: [{ target: dev('charge_amps'), op: 'set', value: 50 }] })]); u.soc(95);
    await u.engine.tick(); assert.strictEqual(u.sent.length, 1, 'unreadable: still tries, the device layer reads first');
    assert.match(JSON.stringify(u.engine.status(1)), /branch/);
  });

  await check('storage: save, change, enable, remove, run log is bounded', () => {
    const def = validateDefinition(base(), CATALOG).def;
    const a = store.create(def, 'admin'); assert.ok(a.id > 0); assert.strictEqual(a.name, 'Geyser on sun'); assert.strictEqual(a.then[0].op, 'on'); assert.strictEqual(a.enabled, true);
    const b = store.update(a.id, { ...def, name: 'Renamed', enabled: false }, 'admin'); assert.strictEqual(b.name, 'Renamed'); assert.strictEqual(b.enabled, false);
    assert.strictEqual(store.setEnabled(a.id, true, 'admin').enabled, true);
    assert.strictEqual(store.list().length, 1);
    for (let i = 0; i < store.RUNS_KEEP + 30; i++) store.logRun({ automationId: a.id, name: 'x', outcome: 'done', detail: String(i) });
    assert.strictEqual(store.recentRuns(500).length, 500); assert.strictEqual(store.recentRuns(500, 999).length, 0);
    assert.strictEqual(require('../modules/database').getDb().prepare('SELECT COUNT(*) n FROM automation_runs').get().n, store.RUNS_KEEP);
    assert.ok(store.remove(a.id)); assert.strictEqual(store.get(a.id), null);
  });

  await check('catalog: built from the configured devices, listed settings only, new devices appear', () => {
    database.setConfig('tuya_devices', JSON.stringify([{ name: 'Geyser', enabled: true, dps: { relay: 1 } }]));
    let c = catalogMod.buildCatalog();
    const g = c.find(e => e.key === 'tuya|Geyser|relay'); assert.ok(g); assert.deepStrictEqual(g.ops, ['on', 'off', 'set']);
    assert.ok(!c.some(e => e.source === 'dongle' || e.source === 'modbus'), 'no raw register targets');
    database.setConfig('tuya_devices', JSON.stringify([{ name: 'Geyser', enabled: true, dps: { relay: 1 } }, { name: 'Pump', enabled: true, dps: { pump: 2 } }]));
    c = catalogMod.buildCatalog();
    assert.ok(c.find(e => e.key === 'tuya|Pump|pump'), 'a new device is offered at once');
    database.setConfig('mqtt_devices', JSON.stringify([{ name: 'B', broker: 'mqtt://b', enabled: true, topics: { fan: 'cmnd/fan/POWER' } }]));
    database.setConfig('ha_devices', JSON.stringify([{ name: 'Home', enabled: true, entities: { lamp: { entityId: 'light.lamp' }, mode: { entityId: 'select.mode' }, level: { entityId: 'number.level' }, scene: { entityId: 'scene.x' } } }]));
    c = catalogMod.buildCatalog();
    assert.deepStrictEqual(c.find(e => e.entity === 'light.lamp').ops, ['on', 'off']);
    assert.deepStrictEqual(c.find(e => e.entity === 'select.mode').ops, ['set']);
    assert.strictEqual(c.find(e => e.entity === 'number.level').kind, 'number');
    assert.ok(!c.find(e => e.entity === 'scene.x'), 'one-shot scenes are not states');
    assert.ok(!c.some(e => e.source === 'mqtt' && e.entity === 'cmnd/fan/POWER' && !e.ops.includes('on')));
  });

  await check('executor: the right call, tagged for the log, even with "Allow device changes" off', async () => {
    controls.setSwitches({ enabled: false });
    const calls = [];
    for (const k of ['ha', 'mqtt', 'tuya']) deviceActions.adapters[k] = async (...a) => { calls.push([k, ...a]); return { success: true }; };
    deviceActions.adapters.recordMetric = () => {};
    database.setConfig('tuya_devices', JSON.stringify([{ name: 'Geyser', enabled: true, dps: { relay: 1 } }]));
    database.setConfig('ha_devices', JSON.stringify([{ name: 'Home', enabled: true, entities: { lamp: { entityId: 'light.lamp' }, level: { entityId: 'number.level' } } }]));
    database.setConfig('mqtt_devices', JSON.stringify([{ name: 'B', broker: 'mqtt://b', enabled: true, topics: { fan: 'cmnd/fan/POWER' } }]));
    const cat = catalogMod.buildCatalog(); const A = { id: 7 };
    const entry = e => cat.find(c => c.entity === e);
    assert.deepStrictEqual(await executor.send(entry('relay'), { op: 'on' }, { known: false }, A), { ok: true });
    assert.deepStrictEqual(calls.pop(), ['tuya', 'Geyser', 1, true]);
    await executor.send(entry('relay'), { op: 'off' }, {}, A); assert.deepStrictEqual(calls.pop(), ['tuya', 'Geyser', 1, false]);
    await executor.send(entry('relay'), { op: 'set', value: 3 }, {}, A); assert.deepStrictEqual(calls.pop(), ['tuya', 'Geyser', 1, 3]);
    await executor.send(entry('light.lamp'), { op: 'off' }, {}, A); assert.deepStrictEqual(calls.pop(), ['ha', 'Home', 'light.turn_off', 'light.lamp', {}]);
    await executor.send(entry('number.level'), { op: 'set', value: 40 }, {}, A); assert.deepStrictEqual(calls.pop(), ['ha', 'Home', 'number.set_value', 'number.level', { value: 40 }]);
    await executor.send(entry('cmnd/fan/POWER'), { op: 'on' }, {}, A); assert.deepStrictEqual(calls.pop(), ['mqtt', 'mqtt://b', 'cmnd/fan/POWER', 'ON']);
    assert.strictEqual(controls.recentLog(1)[0].source, 'automation:7'); assert.strictEqual(controls.recentLog(1)[0].outcome, 'done');
    deviceActions.adapters.tuya = async () => ({ success: false, error: 'offline' });
    assert.deepStrictEqual(await executor.send(entry('relay'), { op: 'on' }, {}, A), { ok: false, error: 'offline' });
    const r = await executor.send({ source: 'device', device: 'Nope', entity: 'x', kind: 'number' }, { op: 'set', value: 1 }, { known: false }, A);
    assert.strictEqual(r.ok, false); assert.doesNotMatch(r.error, /Changing device settings is turned off/, 'the switch is bypassed');
  });

  checks.done(passed);
})().catch(e => { console.error(e); process.exit(1); });
