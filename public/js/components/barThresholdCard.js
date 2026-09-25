/**
 * barThresholdCard — horizontal threshold bar (type key `bar-threshold`).
 *
 * Slice 3 scope: single metric, history-backed horizontal bar with segmented
 * band backgrounds + marker. Value = last point (default) or bucket avg.
 * No canvas, no stacked bars.
 *
 * Data path follows the chart-metric model: the card fetches its own history
 * with GET /api/metrics/history?metric=&hours= and computes CLIENT-side.
 * The `bucket` setting never leaves the client as a query param.
 *
 * Block config: { metric, range:'24h'|'7d', bucket:'15m'|'1h'|'1d',
 *   valueAgg:'last'|'avg', bandMode:'fixed'|'percentile', bands:[{to,color}] }
 */
import {
  MAX_BARS,
  WARM_PALETTE,
  normalizeRange,
  normalizeBucket,
  rangeToHours,
  bucketToMs,
  bucketizeCapped,
  resolveBand,
  percentileBands
} from './barCardLogic.js';

/** Placeholder for a block with no metric configured yet. */
export const NO_METRIC_TEXT = 'Configure a metric';

/** Empty state: metric configured but no history in range. */
export const EMPTY_TEXT = 'No data available for the selected range';

export const DEFAULT_VALUE_AGG = 'last';
export const DEFAULT_BAND_MODE = 'percentile';

/** Normalize a raw block config to warm defaults. */
export function normalizeThresholdConfig(raw) {
  const cfg = raw || {};
  const base = {
    metric: cfg.metric || '',
    range: normalizeRange(cfg.range),
    bucket: normalizeBucket(cfg.bucket),
    valueAgg: cfg.valueAgg === 'avg' ? 'avg' : DEFAULT_VALUE_AGG,
    bandMode: cfg.bandMode === 'fixed' ? 'fixed' : DEFAULT_BAND_MODE,
    bands: Array.isArray(cfg.bands) ? cfg.bands : []
  };
  return base;
}

/** Resolve the effective bands for a set of values under a config. */
export function bandsForValues(values, cfg) {
  const c = normalizeThresholdConfig(cfg);
  if (c.bandMode === 'fixed' && c.bands.length) return c.bands;
  const pb = percentileBands(values, WARM_PALETTE);
  return pb.length ? pb : [{ to: 0, color: WARM_PALETTE[0] }];
}

/** Compute the display value from history points per config. */
export function computeDisplayValue(points, cfg) {
  const c = normalizeThresholdConfig(cfg);
  const capped = bucketizeCapped(points, bucketToMs(c.bucket), c.valueAgg);
  if (!capped.bars.length) return { value: null, bands: [] };
  // For 'last', take the most recent bucket; for 'avg', take average of all
  let val;
  if (c.valueAgg === 'avg') {
    const sum = capped.bars.reduce((s, b) => s + b.value, 0);
    val = sum / capped.bars.length;
  } else {
    val = capped.bars[capped.bars.length - 1].value;
  }
  const bands = bandsForValues(capped.bars.map(b => b.value), c);
  return { value: val, bands };
}

export function buildBarThresholdCard(block) {
  block = block || {};
  const cfg = normalizeThresholdConfig(block.config);
  const container = document.createElement('div');
  container.className = 'bar-threshold-card stat-card';
  container.dataset.blockId = block.id || '';
  container.dataset.barConfig = JSON.stringify(cfg);
  container.style.cssText = 'min-width:0;max-width:100%;box-sizing:border-box;overflow:hidden;height:100%;';

  const titleEl = document.createElement('div');
  titleEl.className = 'stat-label bar-threshold-title';
  titleEl.textContent = cfg.metric || 'Threshold Bar';
  container.appendChild(titleEl);

  const barWrapper = document.createElement('div');
  barWrapper.className = 'bar-threshold-wrapper';
  barWrapper.style.cssText = 'position:relative;height:28px;min-height:28px;background:var(--border);border-radius:4px;overflow:hidden;';
  container.appendChild(barWrapper);

  const valueEl = document.createElement('div');
  valueEl.className = 'bar-threshold-value';
  valueEl.style.cssText = 'position:absolute;top:50%;left:0;right:0;transform:translateY(-50%);text-align:center;color:var(--text-primary);font-weight:600;font-size:0.85rem;pointer-events:none;';
  valueEl.textContent = cfg.metric ? EMPTY_TEXT : NO_METRIC_TEXT;
  container.appendChild(valueEl);

  return container;
}

/** Render the threshold bar into the wrapper. */
export function renderThresholdBar(wrapperEl, valueEl, bands, value) {
  while (wrapperEl.firstChild) wrapperEl.removeChild(wrapperEl.firstChild);

  if (value === null || !Number.isFinite(value) || !bands.length) {
    valueEl.textContent = EMPTY_TEXT;
    valueEl.style.color = 'var(--text-secondary)';
    valueEl.style.fontStyle = 'italic';
    return;
  }

  valueEl.style.fontStyle = 'normal';
  valueEl.style.fontWeight = '600';

  const min = 0;
  const max = bands[bands.length - 1].to;
  const scale = max > min ? (value - min) / (max - min) : 0;
  const pct = Math.max(0, Math.min(100, scale * 100));

  // Band background segments
  let prevTo = min;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const to = b.to > min ? b.to : max;
    const segPct = max > min ? ((to - min) / (max - min)) * 100 : 100 / bands.length;
    const seg = document.createElement('div');
    seg.className = 'bar-threshold-segment';
    seg.style.cssText = 'position:absolute;top:0;bottom:0;left:' + (prevTo - min) / (max - min) * 100 + '%;width:' + (segPct - (prevTo === min ? 0 : 0)) + '%;background:' + (b.color || 'var(--border)') + ';';
    // fix: use absolute positioning correctly
    seg.style.left = (prevTo - min) / (max - min) * 100 + '%';
    seg.style.width = Math.max(0, (to - prevTo) / (max - min) * 100) + '%';
    wrapperEl.appendChild(seg);
    prevTo = to;
  }

  // Marker
  const marker = document.createElement('div');
  marker.className = 'bar-threshold-marker';
  const markerColor = resolveBand(value, bands) || 'var(--accent)';
  marker.style.position = 'absolute';
  marker.style.top = '0';
  marker.style.bottom = '0';
  marker.style.width = '2px';
  marker.style.background = markerColor;
  marker.style.left = pct + '%';
  marker.style.transform = 'translateX(-50%)';
  marker.style.zIndex = '2';
  marker.style.boxShadow = '0 0 4px ' + markerColor;
  wrapperEl.appendChild(marker);

  // Value text
  valueEl.textContent = value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  valueEl.style.color = markerColor;
}

function readCardConfig(container) {
  try { return normalizeThresholdConfig(JSON.parse(container.dataset.barConfig || '{}')); }
  catch (e) { return normalizeThresholdConfig({}); }
}

/** Fetch history for one card and repaint it. Bucket stays client-side. */
export async function refreshOneBarThresholdCard(container) {
  const cfg = readCardConfig(container);
  const titleEl = container.querySelector('.bar-threshold-title');
  const wrapperEl = container.querySelector('.bar-threshold-wrapper');
  const valueEl = container.querySelector('.bar-threshold-value');
  if (!wrapperEl || !valueEl) return;
  if (titleEl) titleEl.textContent = cfg.metric || 'Threshold Bar';
  if (!cfg.metric) {
    valueEl.textContent = NO_METRIC_TEXT;
    valueEl.style.color = 'var(--text-secondary)';
    valueEl.style.fontStyle = 'italic';
    return;
  }
  let points = [];
  try {
    const r = await fetch('/api/metrics/history?metric=' + encodeURIComponent(cfg.metric) + '&hours=' + rangeToHours(cfg.range));
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr)) points = arr;
    }
  } catch (e) { points = []; }
  const { value, bands } = computeDisplayValue(points, cfg);
  renderThresholdBar(wrapperEl, valueEl, bands, value);
}

/** Refresh every bar-threshold card on the page (updater dispatch target). */
export async function refreshBarThresholdCard() {
  const nodes = document.querySelectorAll('.bar-threshold-card');
  for (const node of nodes) {
    try { await refreshOneBarThresholdCard(node); } catch (e) { /* per-card failure stays local */ }
  }
}

/** Live-state push entry point (called by updateWithState). */
export function updateBarThresholdCardFromState(state) {
  if (state) refreshBarThresholdCard();
}