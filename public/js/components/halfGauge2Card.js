export function buildHalfGauge2Card(block = {}) {
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? -100, max = config.max ?? 100;
  const color = config.color || 'var(--accent)';
  const container = document.createElement('div');
  container.className = 'half-gauge2-card stat-card';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.innerHTML = `
    <div class="gauge-wrap" style="position:relative;width:200px;height:110px;margin:0.5rem auto;overflow:hidden;">
      <svg viewBox="0 0 200 110" style="width:100%;height:100%;">
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--border)" stroke-width="35" stroke-linecap="round"/>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="${color}" stroke-width="35" stroke-dasharray="0 260" stroke-dashoffset="130" stroke-linecap="round" id="hg2-fill-${block.id}"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;right:0;display:flex;justify-content:space-between;font-size:0.6rem;color:var(--text-secondary);padding:0 20px;">
        <span id="hg2-min-${block.id}">${min}</span><span id="hg2-max-${block.id}">${max}</span>
      </div>
      <div class="stat-label" style="position:absolute;top:55px;left:0;right:0;text-align:center;font-size:0.85rem;color:var(--text-secondary);">${escapeHtml(config.title || 'Gauge')}</div>
      <div class="stat-value" style="position:absolute;bottom:12px;left:0;right:0;text-align:center;font-size:1.1rem;font-weight:600;line-height:1;" id="hg2-val-${block.id}">--</div>
    </div>`;
  return container;
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

export function updateHalfGauge2Card(state) {
  document.querySelectorAll('.half-gauge2-card').forEach(container => {
    let cfg; try{cfg=JSON.parse(container.dataset.metricMap);}catch(e){return;}
    const v = state.metrics?.[cfg.value]?.value;
    if (v === undefined || v === null) return;
    const min = cfg.min ?? -100, max = cfg.max ?? 100;
    const range = max - min;
    const pct = Math.min(1, Math.max(0, (v - min) / range));
    const arcLen = 260;
    // Positive: fill from 9 o'clock (left) clockwise toward center
    // Negative: fill from 3 o'clock (right) counterclockwise toward center
    let fillLen, offset;
    if (pct >= 0.5) {
      fillLen = (pct - 0.5) * arcLen; // 0 at zero, 130 at full positive
      offset = 0; // start from left edge (9 o'clock)
    } else {
      fillLen = (0.5 - pct) * arcLen; // 0 at zero, 130 at full negative
      offset = arcLen - fillLen; // end at right edge (3 o'clock), extend left
    }
    const id = container.querySelector('[id^="hg2-fill-"]')?.id?.replace('hg2-fill-','');
    const fill = document.getElementById('hg2-fill-' + id);
    if (fill) {
      fill.setAttribute('stroke-dasharray', `${fillLen} ${arcLen}`);
      fill.setAttribute('stroke-dashoffset', offset);
      fill.setAttribute('stroke', pct >= 0.5 ? cfg.color : '#ef4444');
    }
    const val = document.getElementById('hg2-val-' + id);
    if (val) val.textContent = Number(v).toFixed(1);
  });
}
