'use strict';
const checks = require('./_checks');
/**
 * System topology card: today's energy (kWh) beside each circle, with made-up
 * values:
 * - text for each node from the dashboard's daily_*_kwh values: one value for
 *   solar and home, both directions for the grid (in / out) and the battery
 *   (↑ charge / ↓ discharge), a direction with nothing today left out;
 * - no reading: nothing shown;
 * - the line sits just outside its circle on the side away from the hub
 *   (above Solar's circle, below the others), and counts towards the height
 *   taken from the circles above Solar and below Battery;
 * - on by default, with a toggle in the editor that saves false only when off.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'public/js/components/systemTopology.js');

(async () => {
  process.removeAllListeners('warning');   // the module-type notice for public/js
  const { dailyEnergyTexts } = await import(pathToFileURL(FILE).href);

  const t = dailyEnergyTexts({
    daily_solar_kwh: 12.34, daily_consumption_kwh: 123.6,
    daily_grid_import_kwh: 3.21, daily_grid_export_kwh: 1.05,
    daily_battery_charge_kwh: 4, daily_battery_discharge_kwh: 2.5
  });
  assert.deepStrictEqual(t, { solar: '12.3 kWh', home: '124 kWh', grid: '3.2 in · 1.1 out kWh', battery: '↑ 4.0 · ↓ 2.5 kWh' });

  const one = dailyEnergyTexts({ daily_grid_import_kwh: 0, daily_grid_export_kwh: 2.2, daily_battery_charge_kwh: 0.7, daily_battery_discharge_kwh: 0 });
  assert.strictEqual(one.grid, '2.2 kWh out', 'only export today');
  assert.strictEqual(one.battery, '↑ 0.7 kWh', 'only charged today');
  assert.strictEqual(dailyEnergyTexts({ daily_battery_charge_kwh: 0, daily_battery_discharge_kwh: null }).battery, '0.0 kWh', 'nothing either way');
  assert.strictEqual(dailyEnergyTexts({ daily_solar_kwh: '7.5' }).solar, '7.5 kWh', 'numeric text accepted');

  const none = dailyEnergyTexts({ daily_solar_kwh: null, daily_consumption_kwh: undefined, daily_grid_import_kwh: 'n/a' });
  assert.deepStrictEqual(none, { solar: null, home: null, grid: null, battery: null }, 'no reading: nothing shown');
  assert.deepStrictEqual(dailyEnergyTexts(undefined), { solar: null, home: null, grid: null, battery: null });

  // Placement in the card's markup.
  const src = fs.readFileSync(FILE, 'utf8');
  const tpl = src.slice(src.indexOf('container.innerHTML'), src.indexOf('</div>`;'));
  const at = s => { const i = tpl.indexOf(s); assert.ok(i >= 0, `markup has ${s}`); return i; };
  assert.ok(at("energy('solar')") < at('topo-solar-circle'), 'Solar: above its circle');
  assert.ok(at("energy('solar')") > at('<span class="topo-label">Solar</span>'), 'Solar: under its label');
  for (const [key, label] of [['grid', 'Grid'], ['home', 'Home'], ['battery', 'Battery']]) {
    const lbl = at(`topo-label">${label}`), e = at(`energy('${key}')`);
    assert.ok(e < lbl && tpl.lastIndexOf('</div>', lbl) < e, `${label}: below its circle, above its label`);
  }
  assert.match(src, /show_daily_energy !== false/, 'on by default');
  assert.match(src, /\.topo-energy:not\(\[hidden\]\)/, 'shown lines take height from the circles');
  assert.match(src, /state\.current \|\| \{\}/, "read from the dashboard's current values");

  for (const key of ['solar', 'grid', 'home', 'battery']) {
    assert.match(tpl, new RegExp(`<div class="topo-caption">[^\\n]*energy\\('${key}'\\)[^\\n]*</div>`), `${key}: label and energy in one caption`);
  }

  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.match(css, /\.flow-card-2 \.topo-energy\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.flow-card-2 \.topo-energy \{[^}]*color: var\(--text-secondary\)[^}]*white-space: nowrap/, 'text colour, one line');
  // Grid and Home captions are out of flow, so those circles stay level with the hub.
  assert.match(css, /\.flow-card-2 \.topo-grid-node > \.topo-caption, \.flow-card-2 \.topo-home > \.topo-caption \{\s*position: absolute; top: calc\(100% \+ 0\.25rem\)/);

  const editor = fs.readFileSync(path.join(ROOT, 'public/js/editor.js'), 'utf8');
  assert.match(editor, /block\.type === 'flow-card-2'\) html \+= [^\n]*id="modal-daily-energy"/, 'toggle only on the topology card');
  assert.match(editor, /if \(dailyBox && !dailyBox\.checked\) config\.show_daily_energy = false; else delete config\.show_daily_energy;/);

  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
