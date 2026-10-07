import { uid } from '../utils/uid.js';
import { escapeHtml, isNumericValue, formatValueText } from '../utils.js';
import { formatMetric } from './format.js';
import { markBreakdown, applyBreakdowns, chargeFormat, dischargeFormat, exportFormat, socFormat } from './breakdown.js';
const watts = (w) => formatMetric(w, 'W').text;


export function buildFlowCardSquare(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || { solar: 'solar', grid: 'grid_import', battery_power: 'battery_charge', battery_soc: 'battery_soc', consumption: 'consumption', battery_discharge: 'battery_discharge', grid_export: 'grid_export' };
  const invImg = config.inverter_image || '';

  const card = document.createElement('div');
  card.className = 'flow-card-square';
  card.dataset.metricMap = JSON.stringify(metrics);
  card.dataset.blockId = id;
  markBreakdown(card, config);

  card.innerHTML = `
    <div class="fcs-grid">
      <div class="fcs-cell" id="${uid('fcs-solar',id)}">
        <i id="${uid('fcs-icon-solar',id)}" class="fi fi-sr-solar-panel fcs-icon"></i>
        <div class="fcs-info">
          <span class="fcs-label">Solar</span>
          <span class="fcs-value" data-metric="${escapeHtml(metrics.solar)}">—</span>
        </div>
      </div>
      <div class="fcs-cell" id="${uid('fcs-battery',id)}">
        <i id="${uid('fcs-icon-battery',id)}" class="fi fi-sr-battery-full fcs-icon"></i>
        <div class="fcs-info">
          <span class="fcs-label">Battery</span>
          <span class="fcs-value" data-metric="${escapeHtml(metrics.battery_soc)}" id="${uid('fcs-battery-soc',id)}">0%</span>
          <span class="fcs-sub" data-metric="${escapeHtml(metrics.battery_power)}" id="${uid('fcs-battery-power',id)}">—</span>
        </div>
      </div>
      <div class="fcs-cell" id="${uid('fcs-inverter',id)}">
        <div class="fcs-inverter-icon">${invImg ? `<img src="${escapeHtml(invImg)}" alt="Inverter" class="fcs-inv-img">` : 'INV'}</div>
        <div class="fcs-info">
          <span class="fcs-label">Inverter</span>
          <span class="fcs-value" id="${uid('fcs-inverter-mode',id)}">--</span>
        </div>
      </div>
      <div class="fcs-cell" id="${uid('fcs-grid',id)}">
        <i id="${uid('fcs-icon-grid',id)}" class="fi fi-sr-bolt fcs-icon"></i>
        <div class="fcs-info">
          <span class="fcs-label">Grid</span>
          <span class="fcs-value" data-metric="${escapeHtml(metrics.grid)}">—</span>
        </div>
      </div>
    </div>`;
  return card;
}
export function updateFlowCardSquare(state) {
  document.querySelectorAll('.flow-card-square').forEach(card => {
    const id = card.dataset.blockId || '';
    let mm; try{mm=JSON.parse(card.dataset.metricMap);}catch(e){return;}
    // The editor saves grid_import / battery_charge; older layouts use grid / battery_power.
    mm = { ...mm, grid: mm.grid || mm.grid_import, battery_power: mm.battery_power || mm.battery_charge };
    const m = state.metrics || {};
    // Issue #61 Phase 2 (D1/D4/D6): identical guard to flowCard — coerce every
    // slot through the shared numeric predicate before Math.round(), render the
    // raw text for a non-numeric primary slot, and fall back to numeric zero for
    // derived sub-labels.
    const entryOf = (r) => { const n = mm[r]; return n ? m[n] : undefined; };
    const numOf = (r) => { const v = entryOf(r)?.value; return isNumericValue(v) ? v : 0; };
    const rawTextOf = (r) => { const v = entryOf(r)?.value; return (typeof v === 'string' || typeof v === 'boolean') ? formatValueText(v) : null; };
    const solar = numOf('solar'), grid = numOf('grid'), battPower = numOf('battery_power'), battSoc = numOf('battery_soc'), consumption = numOf('consumption');
    const battDischarge = numOf('battery_discharge') || (battPower < 0 ? Math.abs(battPower) : 0);
    const gridExport = numOf('grid_export');
    const el = (s) => document.getElementById(uid(s, id));

    // Solar
    const sv = card.querySelector(`#${uid('fcs-solar',id)} .fcs-value`);
    if (sv) sv.textContent = rawTextOf('solar') ?? (watts(solar));
    const si = el('fcs-icon-solar');
    if (si) si.style.color = solar > 50 ? 'var(--solar)' : 'var(--text-secondary)';

    // Battery
    const bv = el('fcs-battery-soc');
    if (bv) bv.textContent = rawTextOf('battery_soc') ?? (Math.round(battSoc) + '%');
    const bp = el('fcs-battery-power');
    if (bp) {
      if (battPower > 50) bp.textContent = '↑ ' + watts(battPower);
      else if (battDischarge > 50) bp.textContent = '↓ ' + watts(battDischarge);
      else bp.textContent = watts(0);
    }
    const bi = el('fcs-icon-battery');
    if (bi) {
      if (battPower > 50) bi.style.color = 'var(--battery)';
      else if (battDischarge > 50) bi.style.color = 'var(--discharge)';
      else bi.style.color = 'var(--text-secondary)';
      let cl = 'fi fi-sr-battery-empty';
      if (battSoc >= 76) cl = 'fi fi-sr-battery-full'; else if (battSoc >= 51) cl = 'fi fi-sr-battery-three-quarters'; else if (battSoc >= 26) cl = 'fi fi-sr-battery-half'; else if (battSoc >= 1) cl = 'fi fi-sr-battery-quarter';
      bi.className = cl + ' fcs-icon';
    }

    // Grid
    const gv2 = card.querySelector(`#${uid('fcs-grid',id)} .fcs-value`);
    if (gv2) {
      gv2.textContent = gridExport > grid ? watts(gridExport) + ' out' : watts(grid) + ' in';
    }
    const gi = el('fcs-icon-grid');
    if (gi) {
      if (grid > 50) gi.style.color = 'var(--grid)';
      else if (gridExport > 50) gi.style.color = 'var(--export)';
      else gi.style.color = 'var(--text-secondary)';
    }

    applyBreakdowns(card, state, [
      { host: card.querySelector(`#${uid('fcs-solar',id)} .fcs-info`), title: 'Solar', specs: [{ name: mm.solar, unit: 'W' }] },
      { host: card.querySelector(`#${uid('fcs-battery',id)} .fcs-info`), title: 'Battery', specs: [{ name: mm.battery_soc, format: socFormat }, { name: mm.battery_power, format: chargeFormat }, { name: mm.battery_discharge, format: dischargeFormat }] },
      { host: card.querySelector(`#${uid('fcs-grid',id)} .fcs-info`), title: 'Grid', specs: [{ name: mm.grid, unit: 'W' }, { name: mm.grid_export, format: exportFormat }] }
    ]);

    // Inverter mode
    const im = el('fcs-inverter-mode');
    if (im) {
      if (solar > 100) { im.textContent = 'Solar'; im.style.color = 'var(--solar)'; }
      else if (battPower > 50) { im.textContent = 'Charging'; im.style.color = 'var(--battery)'; }
      else if (battDischarge > 50) { im.textContent = 'Battery'; im.style.color = 'var(--discharge)'; }
      else if (grid > 50) { im.textContent = 'Grid'; im.style.color = 'var(--grid)'; }
      else { im.textContent = 'Idle'; im.style.color = 'var(--text-secondary)'; }
    }
  });
}

