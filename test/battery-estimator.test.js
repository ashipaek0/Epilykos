'use strict';
const checks = require('./_checks');
// Battery estimator: SOC from counting each inverter's battery current
// samples, reset to 100% when plainly full and to the empty level at low
// voltage under a light load, started from a voltage guess. Settings save
// points the Battery % role at it and back.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-battery-est-')));
const { initializeDatabase, getDb, setConfig, getConfig, flushMetrics } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const be = require(path.join(REPO, 'modules/batteryEstimator'));

// Defaults from chemistry and system voltage.
const d = be.settings({ enabled: true, capacity_ah: 400, current_inputs: 'inv1_battery_net_current, inv2_battery_net_current', voltage_inputs: ['inv1_battery_voltage'] });
assert.equal(d.enabled, true);
assert.equal(d.cells, 16);
assert.equal(d.full_voltage, 55.2);
assert.equal(d.tail_current_a, 16);
assert.equal(d.empty_voltage, 48);
assert.equal(d.charge_efficiency, 0.99);
assert.deepEqual(d.current_inputs, ['inv1_battery_net_current', 'inv2_battery_net_current']);
const lead = be.settings({ chemistry: 'lead_acid', nominal_voltage: 24, capacity_ah: 200 });
assert.deepEqual([lead.cells, lead.full_voltage, lead.charge_efficiency, lead.enabled], [12, 28.2, 0.85, false]);
assert.equal(be.socFromVoltage(53.12, 'lifepo4', 16), 70);
assert.equal(be.socFromVoltage(40, 'lifepo4', 16), 0);
assert.equal(be.socFromVoltage(12.4, 'lead_acid', 6) > 60, true);
console.log('ok - defaults from chemistry and system voltage; voltage guess');

const cfg = { ...d, empty_enabled: true };
const series = (t0, n, step, a) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * step, v: typeof a === 'function' ? a(i) : a }));
// Start: voltage guess, nothing counted yet.
let r = be.advance(cfg, {}, { samples: { inv1_battery_net_current: series(1000, 1, 15, 0), inv2_battery_net_current: series(1005, 1, 15, 0) }, voltage: 53.12 }, 1010);
assert.equal(r.status.soc, 70); assert.equal(r.state.origin, 'voltage');
// One hour: inverter 1 discharges 20 A, inverter 2 charges 10 A (x0.99), each
// ramping from 0 over its first 15 s: 400 Ah * 70% - 19.958 + 9.879.
r = be.advance(cfg, r.state, { samples: { inv1_battery_net_current: series(1015, 240, 15, -20), inv2_battery_net_current: series(1020, 240, 15, 10) }, voltage: 52 }, 1020 + 239 * 15);
const out = 10 * 15 / 3600 + 20 * 239 * 15 / 3600, inn = (5 * 15 / 3600 + 10 * 239 * 15 / 3600) * 0.99;
assert.ok(Math.abs(r.state.ah - (280 - out + inn)) < 0.001, r.state.ah);
assert.equal(r.status.current, -10);
assert.equal(r.status.uncounted_s, 0);
console.log('ok - both inverters\' samples counted, charging at the charge efficiency');

// A gap of 10 minutes on one inverter is not guessed at.
const before = r.state.ah, t1 = r.state.last.inv1_battery_net_current.t, t2 = r.state.last.inv2_battery_net_current.t;
r = be.advance(cfg, r.state, { samples: { inv1_battery_net_current: [{ t: t1 + 600, v: -20 }], inv2_battery_net_current: [{ t: t2 + 15, v: 0 }] }, voltage: 52 }, t1 + 600);
assert.ok(Math.abs(r.state.ah - (before + 5 * 15 / 3600 * 0.99)) < 0.001, 'only inverter 2\'s 15 s counted');
assert.equal(r.status.uncounted_s, 600);
console.log('ok - a gap is shown as time not counted, not guessed');

// Full: 55.4 V with the current settled for 10 minutes -> 100%.
let s = { ...r.state, ah: 300 }, now = 100000;
const quiet = (t) => ({ inv1_battery_net_current: [{ t, v: 3 }], inv2_battery_net_current: [{ t, v: 2 }] });
for (let i = 0; i <= 20; i++) { now += 30; s = be.advance(cfg, s, { samples: quiet(now), voltage: 55.4 }, now).state; if (i === 15) assert.notEqual(s.origin, 'full', 'not before 10 minutes'); }
assert.equal(s.ah, 400); assert.equal(s.origin, 'full'); assert.equal(s.uncounted, 0);
// High voltage while still charging hard is not full.
s.ah = 300; s.fullSince = null;
for (let i = 0; i < 30; i++) { now += 30; s = be.advance(cfg, s, { samples: { inv1_battery_net_current: [{ t: now, v: 40 }], inv2_battery_net_current: [{ t: now, v: 0 }] }, voltage: 56 }, now).state; }
assert.ok(s.ah < 400 && s.ah > 300);
console.log('ok - set to 100% only when full: voltage up and current settled for the full time');

// Empty: 47.8 V under a light load for 5 minutes -> 5%.
s = { ...s, ah: 120, fullSince: null };
for (let i = 0; i <= 11; i++) { now += 30; s = be.advance(cfg, s, { samples: { inv1_battery_net_current: [{ t: now, v: -6 }], inv2_battery_net_current: [{ t: now, v: -4 }] }, voltage: 47.8 }, now).state; }
assert.equal(s.origin, 'empty'); assert.ok(Math.abs(s.ah - 20) < 0.5, s.ah);
// Low voltage under a heavy load is voltage sag, not empty.
s = { ...s, ah: 120, origin: 'manual', emptySince: null };
for (let i = 0; i <= 11; i++) { now += 30; s = be.advance(cfg, s, { samples: { inv1_battery_net_current: [{ t: now, v: -60 }], inv2_battery_net_current: [{ t: now, v: -40 }] }, voltage: 47.8 }, now).state; }
assert.equal(s.origin, 'manual');
// One inverter missing: no full or empty decisions.
s = { ...s, ah: 300, fullSince: null };
for (let i = 0; i <= 25; i++) { now += 30; s = be.advance(cfg, s, { samples: { inv1_battery_net_current: [{ t: now, v: 1 }] }, voltage: 55.4 }, now).state; }
assert.notEqual(s.ah, 400);
console.log('ok - empty only under a light load; no resets while an inverter is missing');

// Through the database: samples between cycles all counted; outputs written.
setConfig('battery_estimator', JSON.stringify({ enabled: true, capacity_ah: 100, current_inputs: ['a_cur', 'b_cur'], voltage_inputs: ['a_v'] }));
const db = getDb();
const ins = db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)');
const latest = db.prepare('INSERT OR REPLACE INTO latest_metrics(metric, value, timestamp) VALUES (?, ?, ?)');
const T = Math.floor(Date.now() / 1000) - 3600;
ins.run(T, 'a_cur', 0); ins.run(T, 'b_cur', 0); latest.run('a_v', 53.12, T);
be.runBatteryEstimator(T);
assert.equal(be.getStatus().soc, 70);
for (let t = T + 10; t <= T + 3600; t += 10) { ins.run(t, 'a_cur', -10); ins.run(t, 'b_cur', -5); }
latest.run('a_v', 52.5, T + 3600);
be.runBatteryEstimator(T + 3600);
assert.ok(Math.abs(be.getStatus().ah - (70 - 15)) < 0.1, be.getStatus().ah);   // -15 A for an hour (first 10 s ramps)
flushMetrics();
assert.equal(db.prepare("SELECT value FROM latest_metrics WHERE metric = 'battery_soc_estimate'").get().value, be.getStatus().soc);
assert.equal(db.prepare("SELECT value FROM latest_metrics WHERE metric = 'battery_remaining_ah'").get().value, be.getStatus().ah);
be.setSoc(90, T + 3600);
assert.equal(JSON.parse(getConfig('battery_estimator_state')).ah, 90);
assert.throws(() => be.setSoc(120), /0 to 100/);
console.log('ok - every stored sample counted between cycles; outputs written; set by hand');

// Saving: the Battery % role goes to the estimate and back.
setConfig('role_metrics', JSON.stringify({ battery_soc: 'average_battery_soc', solar: 'total_pv_power' }));
be.saveSettings({ enabled: true, capacity_ah: 100, current_inputs: 'a_cur', voltage_inputs: 'a_v', use_for_role: true });
assert.equal(JSON.parse(getConfig('role_metrics')).battery_soc, 'battery_soc_estimate');
assert.ok(JSON.parse(getConfig('user_metrics')).some(m => m.name === 'battery_soc_estimate' && m.unit === '%'));
be.saveSettings({ enabled: true, capacity_ah: 100, current_inputs: 'a_cur', voltage_inputs: 'a_v', use_for_role: false });
assert.deepEqual(JSON.parse(getConfig('role_metrics')), { battery_soc: 'average_battery_soc', solar: 'total_pv_power' });
assert.throws(() => be.saveSettings({ enabled: true, capacity_ah: 0, current_inputs: 'a_cur', voltage_inputs: 'a_v' }), /capacity/);
assert.throws(() => be.saveSettings({ enabled: true, capacity_ah: 100, current_inputs: '', voltage_inputs: 'a_v' }), /current/);
assert.throws(() => be.saveSettings({ enabled: true, capacity_ah: 100, current_inputs: 'a', voltage_inputs: 'a_v', charge_efficiency: 2 }), /efficiency/);
console.log('ok - saving uses the estimate for Battery % and gives the old reading back');
// Settings > Metrics card, its routes, and the cycle order.
const html = fs.readFileSync(path.join(REPO, 'public/settings.html'), 'utf8');
assert.match(html, /<div class="st-card" id="battery-est-card" data-own-save>/);
assert.match(html, /<script src="js\/battery-estimator\.js\?v=1"><\/script>/);
const ui = fs.readFileSync(path.join(REPO, 'public/js/battery-estimator.js'), 'utf8');
assert.doesNotMatch(ui, /type="radio"/);
assert.match(ui, /class="toggle-switch"/, 'toggle switches');
assert.match(ui, /window\.loadRoleMetrics\(\)/, 'the roles card shows Battery % as saved');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
for (const r of ["app.get('/api/battery-estimator'", "app.post('/api/battery-estimator'", "app.post('/api/battery-estimator/soc'", "app.use('/api/battery-estimator', isAuthenticated)"]) assert.ok(server.includes(r), r);
const order = new (require(path.join(REPO, 'services/PollingManager')).PollingManager)().sources.map(x => x.id);
assert.ok(order.indexOf('battery') < order.indexOf('combined') && order.indexOf('combined') < order.indexOf('history'));
console.log('ok - Settings card with toggle switches; signed-in routes; runs before combined metrics');
checks.done();
