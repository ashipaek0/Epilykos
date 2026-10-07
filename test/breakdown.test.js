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
    assert.deepStrictEqual(Object.keys(b.metrics).sort(), ['avg_soc', 'inv1_pv', 'inv2_pv', 'total_pv'], 'energy and disabled metrics have no parts to show');
    assert.deepStrictEqual(b.metrics.total_pv.parts.map(p => p.label), ['Phocos 1', 'Phocos 2']);
    assert.deepStrictEqual(b.metrics.total_pv.parts[0].parts.map(p => p.metric), ['inv1_pv1_power', 'inv1_pv2_power']);
    assert.deepStrictEqual(b.roles, { solar: 'total_pv', battery_soc: 'avg_soc' });
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

  await check('all five flow cards use it; the editor offers it; state carries it', () => {
    for (const f of ['systemTopology', 'flowCard', 'flowCardSquare', 'flowCardSquare2', 'systemOverview']) {
      const src = read(`public/js/components/${f}.js`);
      assert.match(src, /markBreakdown\((card|container), config\)/, `${f} keeps the setting`);
      assert.match(src, /applyBreakdowns\((card|container), (state|dashboardState), \[/, `${f} draws the parts`);
    }
    const ed = read('public/js/editor.js');
    assert.strictEqual((ed.match(/html \+= buildBreakdownFields\(cfg\)/g) || []).length, 3, 'flow card, topology/squares and overview forms');
    assert.strictEqual((ed.match(/^\s+readBreakdownFields\(config\);/gm) || []).length, 3);
    assert.match(read('routes/metrics.js'), /breakdowns: safeBreakdowns\(\)/);
    assert.match(read('public/js/dashboard.js'), /'dailyEnergyBar', 'breakdowns',/, 'a delta with breakdowns updates in place');
    assert.match(read('public/js/components/flowCardSquare.js'), /grid: mm\.grid \|\| mm\.grid_import/, 'square reads the slot names the editor saves');
  });

  console.log(`breakdown: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
