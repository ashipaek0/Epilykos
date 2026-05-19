export function buildBatteryBlock(block = {}) {
  const config = block.config || {};
  const metrics = config.metrics || { soc: 'battery_soc', voltage: 'battery_voltage', current: 'battery_current', power: 'battery_power', temperature: 'battery_temp' };
  const container = document.createElement('div');
  container.className = 'battery-block card';
  container.style.background = 'transparent'; container.style.borderRadius = 'var(--radius)'; container.style.padding = '1rem'; container.style.boxShadow = 'none'; container.style.border = '1px solid transparent';
  container.dataset.metricMap = JSON.stringify(metrics);
  container.innerHTML = `<div class="battery-block-header" style="display:flex;justify-content:space-between;margin-bottom:0.5rem;"><h3 style="margin:0;">${escapeHtml(config.title||'Battery')}</h3></div><div class="battery-soc-display" style="display:flex;align-items:center;gap:1rem;margin-bottom:0.5rem;"><div class="battery-soc-big" data-metric="${escapeHtml(metrics.soc)}" style="font-size:2rem;font-weight:bold;">--%</div><div class="battery-soc-bar" style="flex:1;height:1rem;background:var(--border);border-radius:0.5rem;overflow:hidden;"><div class="battery-soc-fill" style="width:0%;height:100%;background:var(--battery);transition:width 0.3s;"></div></div></div><div class="battery-details" style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.5rem;font-size:0.85rem;"><div>Voltage: <span data-metric="${escapeHtml(metrics.voltage)}">-- V</span></div><div>Current: <span data-metric="${escapeHtml(metrics.current)}">-- A</span></div><div>Power: <span data-metric="${escapeHtml(metrics.power)}">-- W</span></div><div>Temperature: <span data-metric="${escapeHtml(metrics.temperature)}">-- °C</span></div></div>`;
  return container;
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

export function updateBatteryBlock(state) {
  document.querySelectorAll('.battery-block').forEach(container => {
    let mm; try{mm=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const m = state.metrics || {};
    const gv = (r) => { const n = mm[r]; return n ? (m[n]?.value) : undefined; };
    const um = (role, sel, fmt) => { const mn = mm[role]; if (!mn) return; const v = gv(role); if (v === undefined || v === null) return; const e = container.querySelector(sel); if (e) e.textContent = fmt(v); };
    um('soc', '.battery-soc-big', v => Math.round(v)+'%');
    um('voltage', `[data-metric="${mm.voltage}"]`, v => v.toFixed(1)+' V');
    um('current', `[data-metric="${mm.current}"]`, v => v.toFixed(1)+' A');
    um('power', `[data-metric="${mm.power}"]`, v => Math.round(v)+' W');
    um('temperature', `[data-metric="${mm.temperature}"]`, v => v.toFixed(1)+' °C');
    const sv = gv('soc'); if (sv !== undefined && sv !== null) { const f = container.querySelector('.battery-soc-fill'); if (f) f.style.width = Math.min(100,Math.max(0,sv))+'%'; }
  });
}
