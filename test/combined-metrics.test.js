'use strict';
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
  assert.match(wz, /return saveEnergyOffers\(map\)\.then/);
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
console.log(`combined-metrics: ${passed} checks passed`);
