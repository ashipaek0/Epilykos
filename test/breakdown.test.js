'use strict';
// Breakdowns: the parts behind combined totals on the flow cards.
// Server: modules/combinedMetrics.js buildBreakdowns / partLabels.
// Cards:  public/js/components/breakdown.js (loaded as ES modules from a copy).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('url');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-breakdown-'));
process.chdir(tmp);
const database = require('../modules/database');
database.initializeDatabase();
const cm = require('../modules/combinedMetrics');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

(async () => {
  await check('labels: what tells the parts apart, with the source name when they span sources', () => {
    const P = [{ prefix: 'inv1_', name: 'Phocos 1' }, { prefix: 'inv2_', name: 'Phocos 2' }];
    const by = m => P.find(p => m.startsWith(p.prefix)) || null;
    assert.deepStrictEqual(cm.partLabels(['inv1_pv1_power', 'inv1_pv2_power', 'inv2_pv1_power', 'inv2_pv2_power'], by), ['Phocos 1 PV1', 'Phocos 1 PV2', 'Phocos 2 PV1', 'Phocos 2 PV2']);
    assert.deepStrictEqual(cm.partLabels(['inv1_pv1_power', 'inv1_pv2_power'], by), ['PV1', 'PV2'], 'one inverter: no need to repeat its name');
    assert.deepStrictEqual(cm.partLabels(['inv1_pv_power', 'inv2_pv_power'], by), ['Phocos 1', 'Phocos 2']);
    assert.deepStrictEqual(cm.partLabels(['east_roof_kw', 'west_roof_kw']), ['East', 'West'], 'no sources: the words that differ');
    assert.deepStrictEqual(cm.partLabels(['inv1_pv1_power', 'inv1_pv2_power'], by, { inv1_pv2_power: 'West roof' }), ['PV1', 'West roof'], 'a label set on the combined metric wins');
  });

  await check('server: sums and averages with their parts, nested totals inside, roles that point at them', () => {
    database.setConfig('dongle_config', JSON.stringify([
      { name: 'Phocos 1', profile: 'p', prefix: 'inv1_', mappings: { inv1_pv1_power: 'a', inv1_pv2_power: 'b' } },
      { name: 'Phocos 2', profile: 'p', prefix: 'inv2_', mappings: {} }]));
    database.setConfig('combined_metrics', JSON.stringify([
      { id: 'a', name: 'inv1_pv', unit: 'W', fn: 'sum', inputs: ['inv1_pv1_power', 'inv1_pv2_power'] },
      { id: 'b', name: 'inv2_pv', unit: 'W', fn: 'sum', inputs: ['inv2_pv1_power', 'inv2_pv2_power'] },
      { id: 'c', name: 'total_pv', unit: 'W', fn: 'sum', inputs: ['inv1_pv', 'inv2_pv'] },
      { id: 'd', name: 'avg_soc', unit: '%', fn: 'mean', inputs: ['inv1_soc', 'inv2_soc'] },
      { id: 'e', name: 'pv_today', unit: 'kWh', fn: 'energy_today', inputs: ['total_pv'] },
      { id: 'f', name: 'off_total', unit: 'W', fn: 'sum', inputs: ['x', 'y'], enabled: false }]));
    database.setConfig('role_metrics', JSON.stringify({ solar: 'total_pv', battery_soc: 'avg_soc', consumption: 'load' }));
    const b = cm.buildBreakdowns();
    assert.deepStrictEqual(Object.keys(b.metrics).sort(), ['avg_soc', 'inv1_pv', 'inv2_pv', 'pv_today', 'total_pv'], 'disabled metrics have no parts; energy today from a sum does');
    assert.deepStrictEqual(b.metrics.pv_today.parts.map(p => [p.label, p.value]), [['Phocos 1', 0], ['Phocos 2', 0]], 'no kWh counted yet');
    assert.deepStrictEqual(b.metrics.total_pv.parts.map(p => p.label), ['Phocos 1', 'Phocos 2']);
    assert.deepStrictEqual(b.metrics.total_pv.parts[0].parts.map(p => p.metric), ['inv1_pv1_power', 'inv1_pv2_power']);
    assert.deepStrictEqual(b.roles, { solar: 'total_pv', battery_soc: 'avg_soc' });
  });

  await check('energy today from a sum: today\'s kWh per part, nested parts too, adding up to the total', () => {
    const t0 = Math.floor(Date.now() / 1000) - 120;
    const ins = database.getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
    database.setConfig('combined_metrics', JSON.stringify([
      { id: 'a', name: 'inv1_pv', unit: 'W', fn: 'sum', inputs: ['inv1_pv1_power', 'inv1_pv2_power'] },
      { id: 'c', name: 'total_pv', unit: 'W', fn: 'sum', inputs: ['inv1_pv', 'inv2_pv_power'] },
      { id: 'e', name: 'pv_today', unit: 'kWh', fn: 'energy_today', inputs: ['total_pv'] }]));
    database.setConfig('combined_metrics_state', '{}');
    for (let k = 0; k <= 4; k++) {
      const t = t0 + k * 30;
      for (const [m, v] of [['inv1_pv1_power', 1200], ['inv1_pv2_power', 600], ['inv2_pv_power', 1800]]) ins.run(m, v, t);
      cm.runCombinedMetrics(t);
    }
    database.flushMetrics();
    const b = cm.buildBreakdowns().metrics.pv_today;
    assert.strictEqual(b.unit, 'kWh');
    // 2 minutes: 1800 W -> 0.06 kWh; 1200 W -> 0.04; 600 W -> 0.02
    assert.deepStrictEqual(b.parts.map(p => p.value), [0.06, 0.06]);
    assert.deepStrictEqual(b.parts[0].parts.map(p => p.value), [0.04, 0.02]);
    const total = database.getDb().prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('pv_today').value;
    assert.ok(Math.abs(total - 0.12) < 1e-6, `total ${total}`);
  });

  await check('tables: each part\'s daily kWh is kept per day, for energy from a sum and for sums of kWh', () => {
    const day = new Date().toLocaleDateString('en-CA');
    database.setConfig('role_metrics', JSON.stringify({ daily_solar: 'pv_today', daily_consumption: 'load_today' }));
    // pv_today was integrated by the previous check; add a sum of two inverters' own daily kWh.
    const defs = JSON.parse(database.getConfig('combined_metrics'));
    defs.push({ id: 'k', name: 'load_today', unit: 'kWh', fn: 'sum', inputs: ['inv1_load_today', 'inv2_load_today'] });
    database.setConfig('combined_metrics', JSON.stringify(defs));
    const t = Math.floor(Date.now() / 1000);
    const ins = database.getDb().prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
    for (const [m, v] of [['inv1_pv1_power', 1200], ['inv1_pv2_power', 600], ['inv2_pv_power', 1800], ['inv1_load_today', 3.5], ['inv2_load_today', 4.25]]) ins.run(m, v, t);
    cm.runCombinedMetrics(t);
    const parts = cm.partDays(day, day);
    assert.deepStrictEqual(Object.keys(parts).sort(), ['daily_consumption', 'daily_solar']);
    assert.deepStrictEqual(parts.daily_consumption.days[day], { inv1_load_today: 3.5, inv2_load_today: 4.25 });
    assert.ok(parts.daily_solar.days[day].inv1_pv1_power > 0 && parts.daily_solar.days[day].inv1_pv > 0, 'nested parts kept too');
    assert.deepStrictEqual(parts.daily_solar.tree.map(p => p.label), ['Phocos 1', 'Phocos 2']);
    const route = read('routes/metrics.js');
    assert.match(route, /attachParts\(result, dateArray\[0\], dateArray\[dateArray\.length - 1\], row => \[row\.day\]\);/);
    assert.match(route, /attachParts\(result, `\$\{months\[0\]\.key\}-01`/, 'months add up their days');
    assert.match(read('modules/database.js'), /CREATE TABLE IF NOT EXISTS combined_part_daily/);
  });

  await check('tables: one shared response is not reversed per table; months use their label; refresh every 5 minutes', () => {
    const js = read('public/js/tables.js');
    assert.match(js, /data\.slice\(\)\.reverse\(\)/); assert.doesNotMatch(js, /data\.reverse\(\)/);
    assert.match(js, /row\.display \|\| row\.month/);
    assert.match(js, /REFRESH_MS = 5 \* 60 \* 1000/);
    for (const f of ['Daily', 'Monthly']) assert.match(read(`public/js/components/dataTable${f}.js`), /aria-expanded="true" aria-label="Hide table"/);
  });

  await check('labels: saved only for inputs in use; automatic ones sent for the editor', () => {
    const srv = read('server.js');
    assert.match(srv, /for \(const input of def\.inputs\) \{ const l = typeof raw\.labels\[input\] === 'string' \? raw\.labels\[input\]\.trim\(\)\.slice\(0, 40\)/);
    assert.match(srv, /auto_labels: cm\.autoLabels\(\)/);
    assert.deepStrictEqual(Object.keys(cm.autoLabels().c), ['inv1_pv', 'inv2_pv_power']);
    assert.strictEqual(cm.autoLabels().c.inv1_pv, 'Phocos 1', 'from the source name, ignoring custom labels');
    const ui = read('public/js/combined-metrics.js');
    assert.match(ui, /class="input cm-lbl" data-input="/); assert.match(ui, /if \(Object\.keys\(labels\)\.length\) d\.labels = labels; else delete d\.labels;/);
    assert.match(read('public/settings.html'), /combined-metrics\.js\?v=([2-9]|\d{2,})"/);
  });

  // Load the card helper and its imports as ES modules.
  const dir = path.join(tmp, 'esm'); fs.mkdirSync(path.join(dir, 'components'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'utils.mjs'), read('public/js/utils.js'));
  fs.writeFileSync(path.join(dir, 'components', 'format.mjs'), read('public/js/components/format.js').replace("'../utils.js'", "'../utils.mjs'"));
  fs.writeFileSync(path.join(dir, 'components', 'breakdown.mjs'), read('public/js/components/breakdown.js').replace("'../utils.js'", "'../utils.mjs'").replace("'./format.js'", "'./format.mjs'"));
  const bd = await import(pathToFileURL(path.join(dir, 'components', 'breakdown.mjs')).href);
  const state = {
    breakdowns: {
      metrics: {
        total_pv: { fn: 'sum', unit: 'W', parts: [{ metric: 'inv1_pv', label: 'Phocos 1', parts: [{ metric: 'inv1_pv1', label: 'PV1' }, { metric: 'inv1_pv2', label: 'PV2' }] }, { metric: 'inv2_pv', label: 'Phocos 2' }] },
        avg_soc: { fn: 'mean', unit: '%', parts: [{ metric: 'inv1_soc', label: 'Phocos 1' }, { metric: 'inv2_soc', label: 'Phocos 2' }] },
        batt: { fn: 'sum', unit: 'W', parts: [{ metric: 'inv1_batt', label: 'Phocos 1' }, { metric: 'inv2_batt', label: 'Phocos 2' }] }
      },
      roles: { solar: 'total_pv' }
    },
    metrics: { inv1_pv: { value: 2100, unit: 'W' }, inv2_pv: { value: 1900, unit: 'W' }, inv1_pv1: { value: 1200 }, inv1_pv2: { value: 900 }, inv1_soc: { value: 64 }, inv2_soc: { value: 66 }, inv1_batt: { value: 400 }, inv2_batt: { value: -150 } }
  };

  await check('cards: first level, every level, and found by role or metric name', () => {
    assert.deepStrictEqual(bd.nodeRows(state, [{ name: 'solar' }]), [{ label: 'Phocos 1', value: '2.10 kW' }, { label: 'Phocos 2', value: '1.90 kW' }]);
    assert.deepStrictEqual(bd.nodeRows(state, [{ name: 'total_pv' }], 'all').map(r => r.label), ['Phocos 1 PV1', 'Phocos 1 PV2', 'Phocos 2']);
    assert.deepStrictEqual(bd.nodeRows(state, [{ name: 'plain_metric' }]), [], 'not a combined total: nothing to show');
  });

  await check('cards: a battery node merges charge % and power by part; one total used twice counts once', () => {
    const rows = bd.nodeRows(state, [{ name: 'avg_soc', format: bd.socFormat }, { name: 'batt', format: bd.chargeFormat }, { name: 'batt', format: bd.dischargeFormat }]);
    assert.deepStrictEqual(rows, [{ label: 'Phocos 1', value: '64% · ↑ 400 W' }, { label: 'Phocos 2', value: '66% · ↓ 150 W' }]);
  });

  await check('cards: off by default, so a combined total shows no sign of its parts', () => {
    assert.strictEqual(bd.breakdownMode({}), 'off'); assert.strictEqual(bd.breakdownMode({ breakdown: 'bogus' }), 'off');
    assert.strictEqual(bd.breakdownMode({ breakdown: 'hover' }), 'hover'); assert.strictEqual(bd.breakdownDepth({}), 'one');
    assert.match(read('public/js/components/breakdown.js'), /mode === 'off' \? \[\] : nodeRows/);
  });

  await check('cards: energy parts use the kWh sent with them', () => {
    const st = { breakdowns: { metrics: { pv_today: { fn: 'energy_today', unit: 'kWh', parts: [{ metric: 'a', label: 'East', value: 1.234 }, { metric: 'b', label: 'West', value: 0 }] } }, roles: { daily_solar: 'pv_today' } }, metrics: {} };
    assert.deepStrictEqual(bd.nodeRows(st, [{ name: 'daily_solar', format: bd.kwhFormat }]), [{ label: 'East', value: '1.23 kWh' }, { label: 'West', value: '0 kWh' }]);
  });

  await check('all flow cards and Energy totals use it; the editor offers it; state carries it', () => {
    const et = read('public/js/components/energyTotals.js');
    assert.match(et, /specs: \[\{ name: `daily_\$\{t\.field\}`, format: kwhFormat \}\]/, 'each tile follows its daily role');
    assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('energy-totals'\) \|\| blockTypes\.has\('energy-tabs'\)\) updateEnergyTotalsFromState\(state\)/);
    assert.match(read('public/js/components/energyTabs.js'), /breakdown: \(block\.config \|\| \{\}\)\.breakdown/, 'the tabbed card passes its setting to Day totals');
    for (const f of ['systemTopology', 'flowCard', 'flowCardSquare', 'flowCardSquare2', 'systemOverview', 'energyTotals']) {
      const src = read(`public/js/components/${f}.js`);
      assert.match(src, /markBreakdown\((card|container), config\)/, `${f} keeps the setting`);
      assert.match(src, /applyBreakdowns\((card|container), (state|dashboardState), \[/, `${f} draws the parts`);
    }
    const ed = read('public/js/editor.js');
    assert.strictEqual((ed.match(/html \+= buildBreakdownFields\(cfg\)/g) || []).length, 5, 'flow card, topology/squares, overview, Energy totals and the tabbed card');
    assert.strictEqual((ed.match(/^\s+readBreakdownFields\(config\);/gm) || []).length, 5);
    assert.match(read('routes/metrics.js'), /breakdowns: safeBreakdowns\(\)/);
    assert.match(read('public/js/dashboard.js'), /'dailyEnergyBar', 'breakdowns',/, 'a delta with breakdowns updates in place');
    assert.match(read('public/js/components/flowCardSquare.js'), /grid: mm\.grid \|\| mm\.grid_import/, 'square reads the slot names the editor saves');
  });

  await check('gauges and stat cards: each value lists its parts; the editor adds the setting to all ten', () => {
    const cards = { gaugeCard: 'container', halfGaugeCard: 'container', halfGauge2Card: 'container', configurableGaugeCard: 'root', barGauge: 'container', barGaugeRetro: 'container', metricCards: 'grid', multiValueCard: 'container', metricTrendCard: 'root', dualMetricCard: 'root' };
    for (const [f, el] of Object.entries(cards)) {
      const src = read(`public/js/components/${f}.js`);
      assert.match(src, new RegExp(`markBreakdown\\(${el}, ?(block\\.)?config\\)`), `${f} keeps the setting`);
      assert.match(src, new RegExp(`applyBreakdowns\\(${el}, ?state, ?`), `${f} draws the parts`);
    }
    const ed = read('public/js/editor.js');
    assert.match(ed, /var BREAKDOWN_VALUE_TYPES = \['gauge-card', 'configurable-gauge', 'half-gauge', 'half-gauge-2', 'bar-gauge', 'bar-gauge-retro', 'metric-cards', 'multi-value', 'metric-trend', 'dual-metric', 'data-table-daily', 'data-table-monthly'\];/);
    assert.match(ed, /if \(BREAKDOWN_VALUE_TYPES\.indexOf\(block\.type\) !== -1\) html \+= '<fieldset data-ui="section">' \+ buildBreakdownFields/);
    assert.match(ed, /if \(BREAKDOWN_VALUE_TYPES\.indexOf\(block\.type\) !== -1\) readBreakdownFields\(config\);\n  block\.config = config;/);
    const css = read('public/style.css');
    assert.match(css, /\.bar-gauge-row > \.bd-list, \.bg-retro-row > \.bd-list \{ grid-column: 1 \/ -1;/, 'bar rows: parts span the row');
    assert.match(css, /100cqh - 2 \* var\(--card-pad\) - 1\.6em - \(var\(--bd-rows, 0\) \* 1rem \+ 0\.5rem\)/, 'the dial makes room for the parts');
    assert.match(read('public/js/components/breakdown.js'), /host\.style\.setProperty\('--bd-rows', String\(rows\.length\)\)/);
  });

  console.log(`breakdown: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
