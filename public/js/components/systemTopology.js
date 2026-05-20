/**
 * Flow Card 2 — System Topology Diagram
 *
 * Cross/cardinal layout showing energy flow between Solar (top), Battery (bottom),
 * Grid (left), Home (right), and a central Inverter hub.
 *
 * Features:
 * - Animated flow lines with travelling dots showing power direction
 * - Colour-coded icons and circle borders (amber=solar, green=charge, red=grid, amber=discharge)
 * - Hub colour reflects active power source with priority: solar > battery discharge > grid
 * - Solar circle shows utilization % (watts / system capacity)
 * - Battery discharge detected across multiple metric names
 * - Configurable inverter image via block.config.inverter_image
 *
 * @module systemTopology
 */
import { uid } from '../utils/uid.js';

export function buildSystemTopology(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || { solar: 'solar', grid: 'grid_import', battery_power: 'battery_charge', battery_soc: 'battery_soc', consumption: 'consumption' };
  const container = document.createElement('div');
  container.className = 'flow-card-2';
  container.dataset.metricMap = JSON.stringify(metrics);
  container.dataset.blockId = id;

  container.innerHTML = `
    <div class="topo-grid">
      <div class="topo-node topo-solar" id="${uid('topo-solar',id)}">
        <span class="topo-label">Solar</span>
        <div class="topo-node-circle topo-solar-circle"><i id="${uid('topo-icon-solar',id)}" class="fi fi-sr-solar-panel"></i><span class="topo-value" data-metric="${escapeHtml(metrics.solar)}">0 W</span><span class="topo-pct" id="${uid('topo-solar-pct',id)}">0%</span></div>
      </div>
      <div class="topo-node topo-grid-node" id="${uid('topo-grid-node',id)}">
        <div class="topo-node-circle"><i id="${uid('topo-icon-grid',id)}" class="fi fi-sr-bolt"></i><span class="topo-value" data-metric="${escapeHtml(metrics.grid)}">0 W</span></div>
        <span class="topo-label">Grid</span>
      </div>
      <div class="topo-center" id="${uid('topo-center',id)}"><div class="topo-hub">${config.inverter_image?`<img src="${escapeHtml(config.inverter_image)}" alt="Inverter" class="topo-hub-img">`:'INV'}</div></div>
      <div class="topo-node topo-home" id="${uid('topo-home',id)}">
        <div class="topo-node-circle"><i id="${uid('topo-icon-home',id)}" class="fi fi-sr-home"></i><span class="topo-value" data-metric="${escapeHtml(metrics.consumption)}">0 W</span></div>
        <span class="topo-label">Home</span>
      </div>
      <div class="topo-node topo-battery" id="${uid('topo-battery',id)}">
        <div class="topo-node-circle"><i id="${uid('topo-icon-battery',id)}" class="fi fi-sr-battery-full"></i><span class="topo-value" data-metric="${escapeHtml(metrics.battery_soc)}" id="${uid('topo-battery-soc',id)}">0%</span><span class="topo-sub" data-metric="${escapeHtml(metrics.battery_power)}" id="${uid('topo-battery-power',id)}">0 W</span></div>
        <span class="topo-label">Battery</span>
      </div>
      <div class="topo-line topo-line-solar"></div><div class="topo-line topo-line-grid"></div><div class="topo-line topo-line-home"></div><div class="topo-line topo-line-battery"></div>
    </div>`;
  return container;
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

export function updateSystemTopology(state) {
  document.querySelectorAll('.flow-card-2').forEach(container => {
    const id = container.dataset.blockId || '';
    let mm; try{mm=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const m = state.metrics || {};
    const gv = (r) => { const n = mm[r]; return n ? (m[n]?.value || 0) : 0; };
    const solar = gv('solar'), grid = gv('grid'), battPower = gv('battery_power'), battSoc = gv('battery_soc'), consumption = gv('consumption');
    // Battery discharge detection: check common metric names, fall back to negative battery_power
    let battDischarge = 0;
    for (const name of ['battery_discharge', 'battery_discharge_power', 'discharge']) {
      if (m[name]?.value > 0) { battDischarge = m[name].value; break; }
    }
    if (!battDischarge && battPower < 0) battDischarge = Math.abs(battPower);
    const battIsSource = battDischarge > 50;
    const el = (s) => document.getElementById(uid(s, id));
    const sv = container.querySelector('.topo-solar .topo-value'); if (sv) sv.textContent = Math.round(solar) + ' W';
    const sp = el('topo-solar-pct'); if (sp) { const cap = window.systemCapacityKwp || 2.1; const pct = Math.min(100, Math.round((solar / (cap * 1000)) * 100)); sp.textContent = pct + '%'; }
    const gv2 = container.querySelector('.topo-grid-node .topo-value'); if (gv2) { const ge = m[mm.grid === 'grid_import' ? 'grid_export' : mm.grid]?.value || 0; gv2.textContent = ge > grid ? Math.round(ge) + ' W out' : Math.round(grid) + ' W in'; }
    const hv = container.querySelector('.topo-home .topo-value'); if (hv) hv.textContent = Math.round(consumption) + ' W';
    const so = el('topo-battery-soc'); if (so) so.textContent = Math.round(battSoc) + '%';
    const bp = el('topo-battery-power'); if (bp) { if (battPower > 50) bp.textContent = '↑ ' + Math.round(battPower) + ' W'; else if (battDischarge > 50) bp.textContent = '↓ ' + Math.round(battDischarge) + ' W'; else bp.textContent = '0 W'; }
    [['topo-icon-solar', solar > 50 ? 'var(--solar)' : 'var(--text-secondary)']].forEach(([k, v]) => { const e = el(k); if (e) e.style.color = v; });
    const ih = el('topo-icon-home'); if (ih) { if (solar > 100) ih.style.color = 'var(--solar)'; else if (battIsSource) ih.style.color = '#f59e0b'; else if (grid > 50) ih.style.color = 'var(--grid)'; else ih.style.color = 'var(--text-secondary)'; }
    const ig = el('topo-icon-grid'); if (ig) { if (gv('grid') < 0) ig.style.color = '#3b82f6'; else if (grid > 50) ig.style.color = 'var(--grid)'; else ig.style.color = 'var(--text-secondary)'; }
    const ib = el('topo-icon-battery'); if (ib) { if (battPower > 50) ib.style.color = 'var(--battery)'; else if (battDischarge > 50) ib.style.color = '#f59e0b'; else ib.style.color = 'var(--text-secondary)'; let cl = 'fi fi-sr-battery-empty'; if (battSoc >= 76) cl = 'fi fi-sr-battery-full'; else if (battSoc >= 51) cl = 'fi fi-sr-battery-three-quarters'; else if (battSoc >= 26) cl = 'fi fi-sr-battery-half'; else if (battSoc >= 1) cl = 'fi fi-sr-battery-quarter'; ib.className = cl; }
    // Circle borders glow with active power source colour
    const solarCircle = container.querySelector('.topo-solar-circle');
    if (solarCircle) solarCircle.style.borderColor = solar > 50 ? 'var(--solar)' : 'var(--border)';
    const gridCircle = container.querySelector('.topo-grid-node .topo-node-circle');
    if (gridCircle) gridCircle.style.borderColor = grid > 50 ? 'var(--grid)' : (m['grid_export']?.value||0) > 50 ? '#3b82f6' : 'var(--border)';
    const battCircle = container.querySelector('.topo-battery .topo-node-circle');
    if (battCircle) battCircle.style.borderColor = battPower > 50 ? 'var(--battery)' : battDischarge > 50 ? '#f59e0b' : 'var(--border)';
    const homeCircle = container.querySelector('.topo-home .topo-node-circle');
    if (homeCircle) {
      if (solar > 100) homeCircle.style.borderColor = 'var(--solar)';
      else if (battIsSource) homeCircle.style.borderColor = '#f59e0b';
      else if (grid > 50) homeCircle.style.borderColor = 'var(--grid)';
      else homeCircle.style.borderColor = 'var(--border)';
    }
    const hub = container.querySelector('.topo-hub'); if (hub) { if (solar > 100) hub.style.background = 'var(--solar)'; else if (battIsSource) hub.style.background = '#f59e0b'; else if (grid > 50) hub.style.background = 'var(--grid)'; else hub.style.background = 'var(--accent)'; }
    container.querySelectorAll('.topo-line').forEach(l => { l.classList.remove('active', 'reverse'); l.style.background = ''; });
    const setLine = (cls, active, bg, rev) => { const l = container.querySelector(cls); if (l && active) { l.classList.add('active'); if (rev) l.classList.add('reverse'); l.style.background = bg; } };
    setLine('.topo-line-solar', solar > 100, 'var(--solar)', false);
    setLine('.topo-line-grid', grid > 50, 'var(--grid)', false);
    if (gv('grid') < 0 && Math.abs(gv('grid')) > 50) setLine('.topo-line-grid', true, '#3b82f6', true);
    if (consumption > 50) { const l = container.querySelector('.topo-line-home'); if (l) { l.classList.add('active'); if (solar > 100) l.style.background = 'var(--solar)'; else if (battIsSource) l.style.background = '#f59e0b'; else l.style.background = 'var(--grid)'; } }
    // Battery line: show source color when charging, amber when discharging
    if (battPower > 50) {
      const src = solar > 100 ? 'var(--solar)' : grid > 50 ? 'var(--grid)' : 'var(--battery)';
      setLine('.topo-line-battery', true, src, false);
    }
    setLine('.topo-line-battery', battDischarge > 50, '#f59e0b', true);
  });
}
