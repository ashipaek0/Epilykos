export function buildGaugeCard(block = {}) {
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? 0, max = config.max ?? 100;
  const color = config.color || 'var(--accent)';
  const container = document.createElement('div');
  container.className = 'gauge-card stat-card';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.innerHTML = `
    <div class="gauge-wrap" style="position:relative;width:200px;height:200px;margin:0.5rem auto;">
      <svg viewBox="0 0 120 120" style="transform:rotate(-90deg);width:100%;height:100%;">
        <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border)" stroke-width="20"/>
        <circle cx="60" cy="60" r="50" fill="none" stroke="${color}" stroke-width="20" stroke-dasharray="0 314" stroke-linecap="round" id="gauge-fill-${block.id}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
        <span class="stat-value" style="font-size:1.6rem;font-weight:600;line-height:1;" id="gauge-val-${block.id}">--</span>
        <span class="stat-label" style="font-size:1rem;color:var(--text-secondary);margin-top:1px;">${escapeHtml(config.title || 'Gauge')}</span>
      </div>
    </div>`;
  return container;
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

export function updateGaugeCard(state) {
  document.querySelectorAll('.gauge-card').forEach(container => {
    let cfg; try{cfg=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const v = state.metrics?.[cfg.value]?.value;
    if (v === undefined || v === null) return;
    const pct = Math.min(100, Math.max(0, ((v - cfg.min) / (cfg.max - cfg.min)) * 100));
    const id = container.querySelector('[id^="gauge-fill-"]')?.id?.replace('gauge-fill-','');
    const fill = document.getElementById('gauge-fill-' + id);
    if (fill) fill.setAttribute('stroke-dasharray', `${(pct/100)*314} 314`);
    const val = document.getElementById('gauge-val-' + id);
    if (val) {
      const unit = state.metrics?.[cfg.value]?.unit || '';
      val.textContent = Math.round(v) + (unit ? ' ' + unit : '');
    }
  });
}
