'use strict';
const checks = require('./_checks');
// Combined metrics engine (modules/combinedMetrics.js).
process.env.TZ = 'Africa/Lagos';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-combined-'));
process.chdir(tmp);
const database = require('../modules/database');
database.initializeDatabase();
const cm = require('../modules/combinedMetrics');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const T0 = Math.floor(new Date(2026, 9, 7, 12, 0, 0).getTime() / 1000);
const reader = obj => name => (name in obj ? { value: obj[name], timestamp: T0 } : null);
const def = (fn, inputs, extra = {}) => ({ id: 'x', name: 'out', unit: 'W', fn, inputs, ...extra });

check('sum, mean, min, max, difference, product, weighted mean and scale', () => {
  const r = reader({ a: 100, b: 300, c: 600 });
  assert.strictEqual(cm.evaluate(def('sum', ['a', 'b', 'c']), r, null, T0).value, 1000);
  assert.strictEqual(cm.evaluate(def('mean', ['a', 'b']), r, null, T0).value, 200);
  assert.strictEqual(cm.evaluate(def('min', ['a', 'b', 'c']), r, null, T0).value, 100);
  assert.strictEqual(cm.evaluate(def('max', ['a', 'b', 'c']), r, null, T0).value, 600);
  assert.strictEqual(cm.evaluate(def('difference', ['c', 'a', 'b']), r, null, T0).value, 200);
  assert.strictEqual(cm.evaluate(def('product', ['a', 'b']), r, null, T0).value, 30000);
  assert.strictEqual(cm.evaluate(def('weighted_mean', ['a', 'b'], { weights: [1, 3] }), r, null, T0).value, 250);
  assert.strictEqual(cm.evaluate(def('scale', ['a'], { factor: 0.001, offset: 1 }), r, null, T0).value, 1.1);
});

check('a stale or missing input skips the sum, unless missing counts as zero', () => {
  const r = name => ({ a: { value: 100, timestamp: T0 }, b: { value: 300, timestamp: T0 - 900 } })[name] || null;
  assert.match(cm.evaluate(def('sum', ['a', 'b']), r, null, T0).skip, /b is stale/);
  assert.match(cm.evaluate(def('sum', ['a', 'z']), r, null, T0).skip, /z is missing/);
  assert.strictEqual(cm.evaluate(def('sum', ['a', 'b', 'z'], { missing: 'zero' }), r, null, T0).value, 100);
  assert.strictEqual(cm.evaluate(def('sum', ['a', 'b'], { stale_seconds: 1200 }), r, null, T0).value, 400);
});

check('energy today: 2 kW for an hour is 2 kWh, reset at midnight, paused across gaps', () => {
  let s = null, v;
  for (let t = T0; t <= T0 + 3600; t += 30) { const out = cm.evaluate(def('energy_today', ['p']), () => ({ value: 2000, timestamp: t }), s, t); s = out.state; v = out.value; }
  assert.ok(Math.abs(v - 2) < 1e-6, `got ${v}`);
  const gap = cm.evaluate(def('energy_today', ['p']), () => ({ value: 2000, timestamp: T0 + 3600 + 1800 }), s, T0 + 3600 + 1800);
  assert.ok(Math.abs(gap.value - 2) < 1e-6, 'a 30-minute gap adds nothing');
  const midnight = Math.floor(new Date(2026, 9, 8, 0, 0, 30).getTime() / 1000);
  assert.strictEqual(cm.evaluate(def('energy_today', ['p']), () => ({ value: 2000, timestamp: midnight }), gap.state, midnight).value, 0);
  const kw = cm.evaluate(def('energy_today', ['p'], { input_unit: 'kW' }), () => ({ value: 2, timestamp: T0 + 60 }), { day: '2026-10-07', kwh: 0, lastTs: T0, lastKw: 2 }, T0 + 60);
  assert.ok(Math.abs(kw.value - 2 / 60) < 1e-4, 'kW inputs are not divided by 1000');
});

check('energy total keeps counting across days and starts from the given value', () => {
  const s = { kwh: 100, lastTs: T0, lastKw: 1 };
  const out = cm.evaluate(def('energy_total', ['p']), () => ({ value: 1000, timestamp: T0 + 3600 }), s, T0 + 3600);
  assert.ok(Math.abs(out.value - 100) < 1e-6, 'gap of an hour adds nothing');
  const first = cm.evaluate(def('energy_total', ['p'], { start: 5000 }), () => ({ value: 1000, timestamp: T0 }), null, T0);
  assert.strictEqual(first.value, 5000);
});

check('counter today: today\'s increase, surviving a counter reset', () => {
  let s = null;
  const step = v => { const o = cm.evaluate(def('counter_today', ['c']), () => ({ value: v, timestamp: T0 }), s, T0); s = o.state; return o.value; };
  assert.strictEqual(step(1000), 0); assert.strictEqual(step(1004), 4);
  assert.strictEqual(step(2), 4, 'reset to 2 keeps the 4 already counted');
  assert.strictEqual(step(5), 7);
});

check('peak today: the highest so far, added across inputs, starting again at midnight', () => {
  const DAY = 86400;
  let s = null;
  const step = (vals, t = T0) => { const o = cm.evaluate(def('peak_today', Object.keys(vals)), name => ({ value: vals[name], timestamp: t }), s, t); s = o.state; return o.value; };
  assert.strictEqual(step({ a: 100 }), 100, 'the first reading is the peak');
  assert.strictEqual(step({ a: 900 }, T0 + 60), 900);
  assert.strictEqual(step({ a: 400 }, T0 + 120), 900, 'a lower reading leaves it');
  assert.strictEqual(step({ a: 300 }, T0 + 180), 900);
  assert.strictEqual(step({ a: 1000 }, T0 + 240), 1000, 'a higher one raises it');
  assert.strictEqual(step({ a: 0 }, T0 + 6 * 3600), 1000, 'through the evening');
  const nextDay = T0 + DAY - 12 * 3600 + 60;       // the next morning, local time
  assert.strictEqual(step({ a: 0 }, nextDay), 0, 'a new day starts again');
  assert.strictEqual(step({ a: 350 }, nextDay + 3600), 350);
  // Several inputs are added first (all the PV strings), and the reading is not a sum of peaks.
  s = null;
  assert.strictEqual(step({ p1: 500, p2: 700 }), 1200);
  assert.strictEqual(step({ p1: 900, p2: 100 }, T0 + 60), 1200, 'the highest total, not each string\u2019s own highest');
  // A stale or missing input writes nothing and does not touch the peak.
  const late = cm.evaluate(def('peak_today', ['p1']), () => ({ value: 9999, timestamp: T0 - 1000 }), s, T0 + 120);
  assert.ok(late.skip && !late.state, 'stale input is skipped');
  assert.deepStrictEqual(cm.validateDefinition(def('peak_today', ['p1', 'p2'])), []);
});

check('on/off from a limit: above or below, with a gap so a hovering reading does not flip', () => {
  let s = null;
  const step = (v, extra, t = T0) => { const o = cm.evaluate(def('threshold', ['v'], extra), () => ({ value: v, timestamp: t }), s, t); s = o.state; return o.value; };
  // A plain limit: On at 180 and above.
  assert.strictEqual(step(230, { on_at: 180 }), 1);
  assert.strictEqual(step(180, { on_at: 180 }), 1, 'at the limit is On');
  assert.strictEqual(step(179.9, { on_at: 180 }), 0);
  assert.strictEqual(step(0, { on_at: 180 }), 0);
  // With a gap: On at 180, Off below 160; in between it keeps its last state.
  const gap = { on_at: 180, off_at: 160 };
  s = null;
  assert.strictEqual(step(170, gap), 0, 'first reading inside the gap starts Off');
  assert.strictEqual(step(185, gap), 1);
  assert.strictEqual(step(170, gap), 1, 'brown-out inside the gap stays On');
  assert.strictEqual(step(161, gap), 1);
  assert.strictEqual(step(159, gap), 0, 'below the Off value turns Off');
  assert.strictEqual(step(175, gap), 0, 'and stays Off until it reaches the On value');
  assert.strictEqual(step(180, gap), 1);
  // Below: On when it falls to 5 or lower, Off again above 8 (e.g. a low-battery or frost flag).
  s = null;
  const low = { when: 'below', on_at: 5, off_at: 8 };
  assert.strictEqual(step(20, low), 0);
  assert.strictEqual(step(5, low), 1, 'at the limit is On');
  assert.strictEqual(step(7, low), 1, 'inside the gap it keeps its state');
  assert.strictEqual(step(8.5, low), 0);
  assert.strictEqual(step(-3, { when: 'below', on_at: 0 }), 1, 'negative limits work');
  // Any input, any number: power, SoC, a decimal limit.
  s = null;
  assert.strictEqual(step(0.05, { on_at: 0.02 }), 1);
  // A late input writes nothing; counting it as 0 turns it Off.
  const lateRead = () => ({ value: 230, timestamp: T0 - 1000 });
  assert.ok(cm.evaluate(def('threshold', ['v'], { on_at: 180 }), lateRead, null, T0).skip, 'late input waits');
  assert.strictEqual(cm.evaluate(def('threshold', ['v'], { on_at: 180, missing: 'zero' }), lateRead, null, T0).value, 0, 'counted as 0 is Off');
  // Validation.
  assert.deepStrictEqual(cm.validateDefinition(def('threshold', ['v'], gap)), []);
  assert.deepStrictEqual(cm.validateDefinition(def('threshold', ['v'], low)), []);
  assert.match(cm.validateDefinition(def('threshold', ['v'])).join(' '), /On at/, 'needs an On value');
  assert.match(cm.validateDefinition(def('threshold', ['v'], { on_at: 'x' })).join(' '), /On at/);
  assert.match(cm.validateDefinition(def('threshold', ['v'], { on_at: 180, off_at: 200 })).join(' '), /Off value must be .* lower/, 'Off above On makes no gap');
  assert.match(cm.validateDefinition(def('threshold', ['v'], { when: 'below', on_at: 5, off_at: 2 })).join(' '), /Off value must be .* higher/);
  assert.match(cm.validateDefinition(def('threshold', ['v'], { on_at: 1, when: 'sideways' })).join(' '), /above or below/);
  assert.match(cm.validateDefinition(def('threshold', ['a', 'b'], { on_at: 1 })).join(' '), /one input/);
  assert.deepStrictEqual(cm.validateDefinition(def('threshold', ['v'], { on_at: 180, off_at: '' })), [], 'an empty Off value means the same as On');
});

check('on/off metric: runs each cycle, remembers its state, feeds a status consumer', () => {
  const db = database.getDb();
  const NOW = Math.floor(Date.now() / 1000);
  database.setConfig(cm.CONFIG_KEY, JSON.stringify([{ id: 'gs', name: 'grid_status', unit: '', fn: 'threshold', inputs: ['grid_voltage'], when: 'above', on_at: 180, off_at: 160, enabled: true }]));
  database.setConfig(cm.STATE_KEY, '{}');
  const put = v => db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit) VALUES (?, ?, ?, ?)').run('grid_voltage', v, NOW, 'V');
  const read = () => { database.flushMetrics(); return db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('grid_status')?.value; };
  let t = NOW;
  for (const [volts, want] of [[231, 1], [172, 1], [158, 0], [171, 0], [226, 1], [0, 0]]) {
    put(volts); cm.runCombinedMetrics(t++);
    assert.strictEqual(read(), want, `${volts} V -> ${want ? 'On' : 'Off'}`);
  }
  // The grid tracker understands the 1 / 0 it writes.
  const { parseGridState } = require('../modules/utils');
  assert.strictEqual(parseGridState(1, 'grid_status'), 1); assert.strictEqual(parseGridState(0, 'grid_status'), 0);
});

check('editor: On/Off calculation, fields, words and the grid voltage suggestion', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public/js/combined-metrics.js'), 'utf8');
  assert.match(js, /threshold: \{ label: 'On\/Off from a limit'/);
  for (const id of ['cm-when', 'cm-onat', 'cm-offat']) assert.match(js, new RegExp(`id="${id}"`));
  assert.match(js, /function shown\(d, v\)/); assert.match(js, /'On' : 'Off'/);
  assert.match(js, /name: 'grid_status', unit: '', fn: 'threshold'/);
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /'note', 'when', 'on_at', 'off_at'\]/, 'the limits are saved');
  assert.ok(cm.FNS.includes('threshold'));
});

check('validation explains problems plainly', () => {
  assert.deepStrictEqual(cm.validateDefinition(def('sum', ['a', 'b'])), []);
  assert.match(cm.validateDefinition(def('sum', []))[0], /at least one input/);
  assert.match(cm.validateDefinition({ ...def('sum', ['out']) }).join(' '), /itself/);
  assert.match(cm.validateDefinition(def('scale', ['a', 'b'])).join(' '), /one input/);
  assert.match(cm.validateDefinition(def('nope', ['a'])).join(' '), /Pick what to compute/);
  assert.match(cm.validateDefinition(def('sum', ['a']), [{ id: 'y', name: 'OUT' }]).join(' '), /already called/);
});

check('chained definitions run in order; loops are refused', () => {
  const a = { id: 'a', name: 'pv_total', fn: 'sum', inputs: ['pv1', 'pv2'] }, b = { id: 'b', name: 'pv_today', fn: 'energy_today', inputs: ['pv_total'] };
  assert.deepStrictEqual(cm.orderDefinitions([b, a]).ordered.map(d => d.id), ['a', 'b']);
  const x = { id: 'x', name: 'x', fn: 'sum', inputs: ['y'] }, y = { id: 'y', name: 'y', fn: 'sum', inputs: ['x'] };
  assert.deepStrictEqual(cm.orderDefinitions([x, y, a]).ordered.map(d => d.id), ['a']);
});

check('a poll cycle writes enabled definitions, chained in the same cycle, and skips disabled ones', () => {
  const now = Math.floor(Date.now() / 1000);
  const ins = database.getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  for (const [m, v] of [['p1_pv1', 500], ['p1_pv2', 400], ['p2_pv1', 300], ['p2_pv2', 200]]) ins.run(m, v, now);
  database.setConfig('combined_metrics', JSON.stringify([
    { id: 'today', name: 'pv_today', unit: 'kWh', fn: 'energy_today', inputs: ['pv_total'] },
    { id: 'total', name: 'pv_total', unit: 'W', fn: 'sum', inputs: ['p1_pv1', 'p1_pv2', 'p2_pv1', 'p2_pv2'] },
    { id: 'off', name: 'unused', unit: 'W', fn: 'sum', inputs: ['p1_pv1'], enabled: false }
  ]));
  const out = cm.runCombinedMetrics(now);
  assert.strictEqual(out.written, 2);
  database.flushMetrics();
  const row = database.getDb().prepare('SELECT value FROM latest_metrics WHERE metric = ?');
  assert.strictEqual(row.get('pv_total').value, 1400);
  assert.ok(row.get('pv_today'), 'energy written in the same cycle');
  assert.strictEqual(row.get('unused'), undefined);
  assert.strictEqual(cm.getCombinedStatus().total.value, 1400);
});

check('a poll cycle keeps the day\u2019s peak, writes it to the history, and a restart does not lose it', () => {
  const db = database.getDb();
  const now = Math.floor(Date.now() / 1000);
  const put = (m, v, t) => db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run(m, v, t);
  database.setConfig('combined_metrics_state', '{}');
  database.setConfig('combined_metrics', JSON.stringify([
    { id: 'pk', name: 'pv_peak_today', unit: 'W', fn: 'peak_today', inputs: ['s_pv1', 's_pv2'] }
  ]));
  const cycle = (a, b, t) => { put('s_pv1', a, t); put('s_pv2', b, t); cm.runCombinedMetrics(t); database.flushMetrics(); };
  const latest = () => db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('pv_peak_today').value;
  cycle(1000, 500, now);             assert.strictEqual(latest(), 1500);
  cycle(2500, 900, now + 30);        assert.strictEqual(latest(), 3400);
  cycle(300, 200, now + 60);         assert.strictEqual(latest(), 3400, 'a quieter reading leaves the peak');
  // The state is stored, so the peak survives a restart (a new process reads it back).
  assert.ok(JSON.parse(database.getConfig('combined_metrics_state')).pk.peak === 3400);
  const rows = db.prepare('SELECT COUNT(*) n, MAX(value) m FROM metrics WHERE metric = ?').get('pv_peak_today');
  assert.ok(rows.n >= 3 && rows.m === 3400, 'every cycle is in the history, so a chart can take each day\u2019s highest');
});

check('Settings: own-save card, server validation, loops refused, units listed', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const html = read('public/settings.html'), shell = read('public/js/settings-shell.js'), server = read('server.js');
  assert.match(html, /id="combined-card" data-own-save/); assert.match(html, /js\/combined-metrics\.js/);
  assert.match(shell, /!c\.closest\('\[data-own-save\]'\)/);
  assert.match(server, /app\.post\('\/api\/combined-metrics'/); assert.match(server, /cm\.validateDefinition\(def, clean\)/);
  assert.match(server, /use each other in a loop/); assert.match(server, /combined: true/);
  assert.match(read('public/js/combined-metrics.js'), /now - t < 3600/, 'suggestions use metrics with recent readings only');
});
check('Sources links to Combined metrics; the wizard offers energy from power', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('public/settings.html'), /id="st-combine-callout"[\s\S]*href="#metrics\/combined"/);
  const wz = read('public/js/setup.js');
  assert.match(wz, /\{ power: 'solar', daily: 'daily_solar', name: 'solar_energy_today'/);
  assert.match(wz, /fn: 'energy_today', inputs: \[map\[o\.power\]\]/);
  assert.match(wz, /map\[o\.daily\] = o\.name/);
  assert.match(wz, /saveCombineOffers\(map\)\.then\(function \(ok\) \{ return ok \? saveEnergyOffers\(map\) : false; \}\)/, 'inverter totals first, then energy from them');
});
check('any number of inverters: 64 inputs allowed, 65 refused plainly, duplicates refused', () => {
  const many = n => Array.from({ length: n }, (_, i) => `inv${i + 1}_pv_power`);
  assert.deepStrictEqual(cm.validateDefinition(def('sum', many(64))), []);
  assert.match(cm.validateDefinition(def('sum', many(65))).join(' '), /Up to 64 inputs \(this has 65\)/);
  assert.match(cm.validateDefinition(def('sum', ['a', 'a'])).join(' '), /only be used once/);
  const six = Object.fromEntries(many(6).map((n, i) => [n, 900 + i * 20]));
  assert.strictEqual(cm.evaluate(def('sum', many(6)), reader(six), null, T0).value, 5700);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(src, /inputs:[^\n]*\.slice\(0, 16\)/, 'no silent cut to 16 inputs');
});
check('editor: add all metrics that match a name or pattern', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public/js/combined-metrics.js'), 'utf8');
  assert.match(js, /id="cm-match"/); assert.match(js, /function matchNames\(text\)/); assert.match(js, /q\.split\('\*'\)/);
  assert.match(js, /\(isRecent\(m\) \? ' checked' : ''\)/, 'metrics without recent readings start unticked');
});
check('wizard: any number of inverters like the first, kept sources, totals across inverters', () => {
  const wz = fs.readFileSync(path.join(__dirname, '..', 'public/js/setup.js'), 'utf8');
  assert.match(wz, /function moreInvertersHtml\(kind\)/); assert.match(wz, /action === 'add-inverter'/);
  assert.match(wz, /var MORE_KINDS = \['dongle', 'modbusTcp', 'modbusSerial', 'rs232'\]/, 'not just the dongle / Bluetooth card');
  for (const k of ['dongle', 'rs232', 'modbusSerial', 'modbusTcp']) assert.match(wz, new RegExp(`moreInvertersHtml\\('${k}'\\)`), `${k} card offers more inverters`);
  assert.match(wz, /return withExtras\('rs232', buildRS232Device\(\)\)/); assert.match(wz, /withExtras\('modbusSerial', \{/); assert.match(wz, /withExtras\('modbusTcp', \{/);
  assert.match(wz, /function withPrefix\(mappings, from, to\)/);
  assert.match(wz, /return out\.concat\(state\.keep\.dongle_config \|\| \[\]\)/, 'inverters on other profiles kept');
  assert.match(wz, /would read the same inverter twice/, 'two rows pointing at one inverter refused');
  assert.match(wz, /Object\.keys\(bySrc\)\.forEach\(function \(k\) \{ bySrc\[k\] = asArray\(bySrc\[k\]\); \}\)/, 'saved lists parsed once, so the first Modbus unit is recognised');
  const all = /'rs232_devices', 'modbus_devices', 'bms_devices', 'external_sources'\]/;
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes/auth.js'), 'utf8'), all, 'Modbus, BMS and REST count as a data source');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), all, 'Start fresh clears every kind of source');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'modules/modbus.js'), 'utf8'), /\(device\.prefix \|\| ''\) \+ reg\.metric/, 'Modbus honours the prefix without mappings');
  assert.match(wz, /ha_devices: JSON\.stringify\(withKept\('ha_devices'/, 'a second Home Assistant etc. kept');
  assert.match(wz, /function combineOffers\(\)/); assert.match(wz, /\['battery_soc', 'Battery charge \(%\)', 'mean', '%'\]/);
  assert.match(wz, /have the same prefix, so their readings would overwrite each other/);
});
console.log(`combined-metrics: ${passed} checks passed`);
checks.done();
