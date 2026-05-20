export function buildHalfGaugeCard(block = {}) {
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? -100, max = config.max ?? 100;
  const color = config.color || 'var(--accent)';
  const container = document.createElement('div');
  container.className = 'half-gauge-card stat-card';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.innerHTML = `
    <div class="gauge-wrap" style="position:relative;width:200px;height:110px;margin:0.5rem auto;overflow:hidden;">
      <svg viewBox="0 0 200 110" style="width:100%;height:100%;">
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--border)" stroke-width="35" stroke-linecap="round"/>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="${color}" stroke-width="35" stroke-dasharray="0 260" stroke-dashoffset="130" stroke-linecap="round" id="hgauge-fill-${block.id}"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;right:0;display:flex;justify-content:space-between;font-size:0.6rem;color:var(--text-secondary);padding:0 20px;">
        <span id="hgauge-min-${block.id}">${min}</span><span id="hgauge-max-${block.id}">${max}</span>
      </div>
      <div class="stat-label" style="position:absolute;top:55px;left:0;right:0;text-align:center;font-size:0.85rem;color:var(--text-secondary);">${escapeHtml(config.title || 'Gauge')}</div>
      <div class="stat-value" style="position:absolute;bottom:12px;left:0;right:0;text-align:center;font-size:1.1rem;font-weight:600;line-height:1;" id="hgauge-val-${block.id}">--</div>
    </div>`;
  return container;
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

export function updateHalfGaugeCard(state) {
  document.querySelectorAll('.half-gauge-card').forEach(container => {
    let cfg; try{cfg=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const v = state.metrics?.[cfg.value]?.value;
    if (v === undefined || v === null) return;
    const min = cfg.min ?? -100, max = cfg.max ?? 100;
    const range = max - min;
    // pct: 0 = full left (negative max), 0.5 = center zero, 1 = full right (positive max)
    const pct = Math.min(1, Math.max(0, (v - min) / range));
    const arcLen = 260; // total arc length
    const fillLen = Math.abs(pct - 0.5) * arcLen; // distance from center
    // dashoffset: shift so the zero point is at the bottom center (half the arc)
    const offset = pct >= 0.5 ? (arcLen / 2) : (arcLen / 2) - fillLen;
    const id = container.querySelector('[id^="hgauge-fill-"]')?.id?.replace('hgauge-fill-','');
    const fill = document.getElementById('hgauge-fill-' + id);
    if (fill) {
      fill.setAttribute('stroke-dasharray', `${fillLen} ${arcLen}`);
      fill.setAttribute('stroke-dashoffset', offset);
      fill.setAttribute('stroke', pct >= 0.5 ? cfg.color : '#ef4444');
    }
    const val = document.getElementById('hgauge-val-' + id);
    if (val) val.textContent = Number(v).toFixed(1);
  });
}
