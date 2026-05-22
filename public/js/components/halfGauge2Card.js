/**
 * Half Gauge 2 Card — 180° semicircle (9 o'clock to 3 o'clock).
 * Zero at 12 o'clock (top centre). Positive fills clockwise to 3 o'clock (right).
 * Negative fills counter-clockwise to 9 o'clock (left).
 */
export function buildHalfGauge2Card(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? -100;
  const max = config.max ?? 100;
  const color = config.color || '#3b82f6';

  const container = document.createElement('div');
  container.className = 'half-gauge2-card stat-card';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.dataset.blockId = id;

  const svgId = `hg2-fill-${id}`;
  container.innerHTML = `
    <div class="gauge-wrap" style="position:relative;width:100%;max-width:220px;aspect-ratio:2/1.1;margin:0.25rem auto 0;overflow:hidden;">
      <svg viewBox="0 0 200 110" style="width:100%;height:100%;display:block;">
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--border)" stroke-width="35" stroke-linecap="round"/>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="${color}" stroke-width="35" stroke-dasharray="0 260" stroke-dashoffset="130" stroke-linecap="round" id="${svgId}"/>
      </svg>
      <div class="stat-label" style="position:absolute;top:50%;left:0;right:0;text-align:center;font-size:0.75rem;color:var(--text-secondary);transform:translateY(-60%);">${escapeHtml(config.title || 'Gauge')}</div>
      <div class="stat-value" style="position:absolute;bottom:10%;left:0;right:0;text-align:center;font-size:clamp(0.85rem,2.5vw,1.1rem);font-weight:600;line-height:1;" id="hg2-val-${id}">--</div>
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
    const pct = (v - min) / range;
    const arcLen = Math.PI * 80; // ≈ 251.3 — true semicircle arc length (radius=80)
    const midArc = arcLen / 2;    // ≈ 125.7 — position of 12 o'clock
    const color = cfg.color || '#3b82f6';
    const negColor = '#ef4444';
    // 12 o'clock (top centre) is the neutral point
    // Positive: clockwise from 12 o'clock → 3 o'clock (right)
    // Negative: counter-clockwise from 12 o'clock → 9 o'clock (left)
    const zeroPoint = Math.max(0, Math.min(1, (0 - min) / range));
    const maxDist = Math.max(zeroPoint, 1 - zeroPoint);
    const fillLen = Math.min(midArc, (Math.abs(pct - zeroPoint) / maxDist) * midArc);
    const offset = pct >= zeroPoint ? -midArc : fillLen - midArc;
    const id = container.querySelector('[id^="hg2-fill-"]')?.id?.replace('hg2-fill-','');
    const fill = document.getElementById('hg2-fill-' + id);
    if (fill) {
      fill.setAttribute('stroke-dasharray', `${fillLen} ${arcLen}`);
      fill.setAttribute('stroke-dashoffset', offset);
      fill.setAttribute('stroke', pct >= zeroPoint ? color : negColor);
    }
    const val = document.getElementById('hg2-val-' + id);
    if (val) val.textContent = Math.round(v);
  });
}
