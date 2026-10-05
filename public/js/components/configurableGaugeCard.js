import { normalizeConfig, finiteMetric, scaleRatio, thresholdBands, historyAreaPath, historyPath, historyUrl } from './configurableGaugeLogic.js';
import { formatMetric } from './format.js';

const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const REQUEST_TTL = 30_000;
const requests = new Map();
let instanceSequence = 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function arcPath(cx, cy, radius, start, end) {
  const point = angle => [cx + radius * Math.cos((angle - 90) * Math.PI / 180), cy + radius * Math.sin((angle - 90) * Math.PI / 180)];
  const [x1, y1] = point(start), [x2, y2] = point(end);
  return `M${x1.toFixed(3)} ${y1.toFixed(3)} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}
function path(d, color, width, cls, extra = '') {
  return `<path class="${cls}" d="${d}" fill="none" stroke="${esc(color)}" stroke-width="${width}" stroke-linecap="butt" ${extra}/>`;
}
export function gaugeMarkup(c, id) {
  const start = 180 + c.opening / 2 + c.rotation, end = 540 - c.opening / 2 + c.rotation, sweep = end - start;
  const radius = 68, ringWidth = Math.min(c.arcThickness, 62);
  let layers = path(arcPath(100, 100, radius, start, end), c.trackColor || 'var(--gauge-track, var(--border))', ringWidth, 'configurable-gauge-track');
  if (c.band.show) {
    const bandRadius = clamp(radius + ringWidth / 2 + c.band.spacing + c.band.thickness / 2, 76, 98);
    const bandWidth = Math.min(c.band.thickness, 200 - 2 * bandRadius - 2);
    if (bandWidth > 0) {
      layers += path(arcPath(100, 100, bandRadius, start, end), c.band.trackColor || 'var(--gauge-track, var(--border))', bandWidth, 'configurable-gauge-band-track');
      let from = 0;
      for (const threshold of thresholdBands(c.band.thresholds, c.min, c.max)) {
        const to = (threshold.value - c.min) / (c.max - c.min);
        if (to > from) layers += path(arcPath(100, 100, bandRadius, start + sweep * from, start + sweep * to), threshold.color, bandWidth, 'configurable-gauge-band');
        from = to;
      }
    }
  }
  const defs = [];
  if (c.preset === 'segmented') {
    const gap = Math.min(sweep / c.segmentCount * .8, c.segmentGap / 100 * sweep / c.segmentCount);
    for (let i = 0; i < c.segmentCount; i++) {
      const d = arcPath(100, 100, radius, start + sweep * i / c.segmentCount + gap / 2, start + sweep * (i + 1) / c.segmentCount - gap / 2);
      const width = Math.min(c.arcThickness, 62);
      layers += path(d, c.trackColor || 'var(--gauge-track, var(--border))', width, 'configurable-gauge-segment-track', `data-segment="${i}"`);
      const segmentColor = c.segmentColors[i % c.segmentColors.length] || c.arcColor || 'var(--accent)';
      const effectColor = c.style === 'gradient' ? `url(#${id}-gradient-${i})` : segmentColor;
      const effect = c.style === 'glow' ? `filter="url(#${id}-glow)"` : '';
      if (c.style === 'gradient') defs.push(`<linearGradient id="${id}-gradient-${i}"><stop stop-color="${esc(segmentColor)}"/><stop offset="1" stop-color="${esc(c.gradientEnd || 'var(--accent)')}"/></linearGradient>`);
      layers += path(d, effectColor, width, 'configurable-gauge-segment-fill', `data-segment="${i}" style="visibility:hidden" ${effect}`);
    }
  } else {
    const effectColor = c.style === 'gradient' ? `url(#${id}-gradient)` : (c.arcColor || 'var(--accent)');
    const effect = c.style === 'glow' ? `filter="url(#${id}-glow)"` : '';
    layers += path(arcPath(100, 100, radius, start, end), effectColor, ringWidth, 'configurable-gauge-fill', `style="visibility:hidden" ${effect}`);
  }
  if (c.style === 'gradient' && c.preset !== 'segmented') defs.push(`<linearGradient id="${id}-gradient"><stop stop-color="${esc(c.arcColor || 'var(--accent)')}"/><stop offset="1" stop-color="${esc(c.gradientEnd || 'var(--accent)')}"/></linearGradient>`);
  if (c.style === 'glow') defs.push(`<filter id="${id}-glow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="240" height="240"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
  return `<svg class="configurable-gauge-svg" viewBox="0 0 200 200" role="img" aria-label="Gauge"><defs>${defs.join('')}</defs>${layers}</svg>`;
}
function requestFor(key, url) {
  const now = Date.now(), cached = requests.get(key);
  if (cached && (cached.promise || now - cached.time < REQUEST_TTL)) return cached;
  const record = { time: now, data: null, promise: null };
  record.promise = fetch(url).then(response => { if (!response.ok) throw Error(`history ${response.status}`); return response.json(); })
    .then(data => { record.data = Array.isArray(data) ? data : []; record.time = Date.now(); return record.data; })
    .catch(error => { if (requests.get(key) === record) requests.delete(key); throw error; })
    .finally(() => { record.promise = null; });
  requests.set(key, record);
  while (requests.size > 32) requests.delete(requests.keys().next().value);
  return record;
}
function paintHistory(root, c, samples) {
  const line = root.querySelector('.configurable-gauge-history-line'), area = root.querySelector('.configurable-gauge-history-area');
  const d = historyPath(samples);
  line?.setAttribute('d', d); line?.setAttribute('stroke-width', c.graph.thickness); line?.setAttribute('stroke', c.graph.color || 'var(--accent)');
  area?.setAttribute('d', c.graph.mode === 'area' ? historyAreaPath(samples) : '');
  area?.setAttribute('fill', c.graph.color || 'var(--accent)'); area?.setAttribute('fill-opacity', c.graph.opacity);
  const marker = root.querySelector('.configurable-gauge-history-marker'), lastRun = d.match(/M[^M]*$/), last = lastRun?.[0].match(/([\d.]+),([\d.]+)$/);
  if (marker) { marker.style.display = c.graph.marker && last ? '' : 'none'; if (last) { marker.setAttribute('cx', last[1]); marker.setAttribute('cy', last[2]); } }
}
async function refreshHistory(root, c) {
  const metric = c.graph.metric || c.metric, key = `${metric}|${c.graph.window}`;
  if (!c.graph.show || !metric || !root.isConnected) return;
  if (root._gaugeHistoryKey !== key) { root._gaugeHistoryKey = key; root._gaugeGeneration++; paintHistory(root, c, []); }
  const generation = root._gaugeGeneration;
  try {
    const record = requestFor(key, historyUrl(metric, c.graph.window));
    const data = record.promise ? await record.promise : record.data;
    if (root.isConnected && root._gaugeGeneration === generation && root._gaugeHistoryKey === key) paintHistory(root, c, data || []);
  } catch (_) { if (root.isConnected && root._gaugeGeneration === generation) paintHistory(root, c, []); }
}
/**
 * Inner-circle layout in % of the dial (the SVG is 200 units wide, ring
 * centred on r = 68). Readout and history line sit inside the ring's hole, so
 * a thicker ring shrinks them instead of letting them overlap the arc.
 */
export function innerLayout(c) {
  const ring = Math.min(c.arcThickness, 62), inner = Math.max(12, 68 - ring / 2 - 2); // radius in SVG units
  const R = inner / 2; // as % of the dial's width/height
  const pct = v => `${v.toFixed(2)}%`;
  return {
    readout: `left:${pct(50 - 0.9 * R)};width:${pct(1.8 * R)};top:${pct(50 - (c.graph.show ? 0.62 : 0.32) * R)};height:${pct(0.64 * R)};font-size:calc(${(0.46 * R).toFixed(2)}cqi * var(--card-font-scale, 1));`,
    history: `left:${pct(50 - 0.72 * R)};width:${pct(1.44 * R)};top:${pct(50 + 0.12 * R)};height:${pct(0.42 * R)};`
  };
}
export function buildConfigurableGaugeCard(block = {}) {
  const c = normalizeConfig(block.config), root = document.createElement('div'), id = `configurable-gauge-${++instanceSequence}`;
  const layout = innerLayout(c);
  root.className = 'configurable-gauge-card stat-card'; root.dataset.blockId = block.id || ''; root.dataset.instanceId = id; root.dataset.config = JSON.stringify(c);
  root.style.minWidth = '0'; root.style.overflow = 'hidden'; root.style.boxSizing = 'border-box';
  // Only what the person set: otherwise the card keeps the shared card
  // surface (background, 1px border, radius) like every other card.
  if (c.background) root.style.backgroundColor = c.background;
  if (c.borderColor && c.borderWidth > 0) { root.style.borderColor = c.borderColor; root.style.borderWidth = `${c.borderWidth}px`; root.style.borderStyle = 'solid'; }
  if (c.radius !== 12) root.style.borderRadius = `${c.radius}px`;
  root.style.setProperty('--cg-size', `${c.size}px`);
  root.innerHTML = `<div class="configurable-gauge-title">${esc(c.title || c.metric || 'Gauge')}</div><div class="configurable-gauge-viz">${gaugeMarkup(c, id)}<div class="configurable-gauge-readout" style="${layout.readout}${c.readoutSize ? `font-size:calc(${c.readoutSize}px * var(--card-font-scale, 1));` : ''}${c.readoutColor ? `color:${esc(c.readoutColor)};` : ''}${c.showReadout ? '' : 'display:none'}"><span class="configurable-gauge-value">—</span><span class="configurable-gauge-unit">${esc(c.unit)}</span></div><svg class="configurable-gauge-history" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Metric history" style="${layout.history}display:${c.graph.show ? 'block' : 'none'}"><path class="configurable-gauge-history-area" fill="${esc(c.graph.color || 'var(--accent)')}" fill-opacity="${c.graph.opacity}"/><path class="configurable-gauge-history-line" fill="none" stroke="${esc(c.graph.color || 'var(--accent)')}" stroke-width="${c.graph.thickness}"/><circle class="configurable-gauge-history-marker" r="1.5" fill="${esc(c.graph.color || 'var(--accent)')}" style="display:none"/></svg></div>`;
  root._gaugeGeneration = 0; root._gaugeHistoryKey = ''; root._gaugeRefreshAt = 0;
  return root;
}
function setFill(root, c, ratio) {
  const fill = root.querySelector('.configurable-gauge-fill');
  if (fill) {
    fill.style.visibility = ratio === null || ratio <= 0 ? 'hidden' : '';
    fill.setAttribute('stroke-dasharray', `${ratio * 100} 100`); fill.setAttribute('pathLength', '100');
  }
  root.querySelectorAll('.configurable-gauge-segment-fill').forEach((segment, index) => {
    const amount = ratio === null ? 0 : ratio * c.segmentCount - index, full = clamp(amount, 0, 1);
    segment.style.visibility = full <= 0 ? 'hidden' : '';
    segment.setAttribute('stroke-dasharray', `${full * 100} 100`); segment.setAttribute('pathLength', '100');
  });
}
export function updateConfigurableGaugeCards(state = {}) {
  document.querySelectorAll('.configurable-gauge-card').forEach(root => {
    let c; try { c = normalizeConfig(JSON.parse(root.dataset.config || '{}')); } catch (_) { c = normalizeConfig(); }
    const entry = state?.metrics?.[c.metric], value = finiteMetric(entry?.value);
    const valueNode = root.querySelector('.configurable-gauge-value'), unitNode = root.querySelector('.configurable-gauge-unit');
    // formatMetric picks the shown unit too (W → kW from 1000 up).
    const shown = value === null ? null : formatMetric(value, c.unit || entry?.unit || '', { decimals: c.precision ?? undefined });
    if (valueNode) valueNode.textContent = shown ? shown.value : '—';
    if (unitNode) unitNode.textContent = shown ? shown.unit : '';
    setFill(root, c, c.validScale ? scaleRatio(value, c.min, c.max) : null);
    const graph = root.querySelector('.configurable-gauge-history'), key = `${c.graph.metric || c.metric}|${c.graph.window}`;
    if (graph) graph.style.display = c.graph.show ? '' : 'none';
    if (c.graph.show && (key !== root._gaugeHistoryKey || Date.now() - root._gaugeRefreshAt >= REQUEST_TTL)) {
      root._gaugeRefreshAt = Date.now(); refreshHistory(root, c);
    }
    if (!c.graph.show && root._gaugeHistoryKey) { root._gaugeGeneration++; root._gaugeHistoryKey = ''; paintHistory(root, c, []); }
  });
}
