/**
 * barSingleCard — single-metric vertical bar card (type key `bar-single`).
 *
 * Slice 1 scope: one metric, history-backed vertical div bars coloured by the
 * shared band engine (barCardLogic.js). No canvas, no stacked bars, no
 * thresholds.
 *
 * Data path follows the chart-metric model: the card fetches its own history
 * with GET /api/metrics/history?metric=&hours= and buckets CLIENT-side.
 * The `bucket` setting never leaves the client as a query param.
 *
 * Block config: { metric, range:'24h'|'7d', bucket:'15m'|'1h'|'1d',
 *   bandMode:'fixed'|'percentile', bands:[{to,color}] }
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

export const DEFAULT_BAND_MODE = 'percentile';

/** Normalize a raw block config to warm defaults. */
export function normalizeBarConfig(raw) {
  const cfg = raw || {};
  return {
    metric: cfg.metric || '',
    range: normalizeRange(cfg.range),
    bucket: normalizeBucket(cfg.bucket),
    bandMode: cfg.bandMode === 'fixed' ? 'fixed' : DEFAULT_BAND_MODE,
    bands: Array.isArray(cfg.bands) ? cfg.bands : []
  };
}

/** Resolve the effective bands for a set of bar values under a config. */
export function bandsForValues(values, cfg) {
  const c = normalizeBarConfig(cfg);
  if (c.bandMode === 'fixed' && c.bands.length) return c.bands;
  const pb = percentileBands(values, WARM_PALETTE);
  return pb.length ? pb : [{ to: 0, color: WARM_PALETTE[0] }];
}

export function buildBarSingleCard(block) {
  block = block || {};
  const cfg = normalizeBarConfig(block.config);
  const container = document.createElement('div');
  container.className = 'bar-single-card stat-card';
  container.dataset.blockId = block.id || '';
  // The refresher re-reads config off the live DOM node, same convention as
  // textMetricCard/gaugeCard: a config change only needs a re-render.
  container.dataset.barConfig = JSON.stringify(cfg);
  container.style.cssText = 'min-width:0;max-width:100%;box-sizing:border-box;overflow:hidden;height:100%;';

  const titleEl = document.createElement('div');
  titleEl.className = 'stat-label bar-single-title';
  titleEl.textContent = cfg.metric || 'Bar Card';
  container.appendChild(titleEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'bar-single-body';
  bodyEl.style.cssText = 'display:flex;align-items:flex-end;gap:2px;min-height:80px;';
  container.appendChild(bodyEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'bar-single-status';
  statusEl.style.cssText = 'color:var(--text-secondary);font-style:italic;';
  statusEl.textContent = cfg.metric ? EMPTY_TEXT : NO_METRIC_TEXT;
  container.appendChild(statusEl);

  return container;
}

/**
 * Render bars into the card body. At most MAX_BARS divs; taller value =
 * taller bar, colour from resolveBand. textContent only — never innerHTML.
 */
export function renderBars(bodyEl, statusEl, bars, bands) {
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  if (!bars.length) {
    statusEl.textContent = EMPTY_TEXT;
    statusEl.style.display = '';
    return;
  }
  statusEl.textContent = '';
  statusEl.style.display = 'none';
  let max = 0;
  for (const b of bars) { if (b.value > max) max = b.value; }
  if (!(max > 0)) max = 1;
  const n = Math.min(bars.length, MAX_BARS);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const bar = document.createElement('div');
    bar.className = 'bar-single-bar';
    const pct = Math.max(0, Math.min(100, (b.value / max) * 100));
    bar.style.cssText = 'flex:1 1 0;min-width:2px;background:' +
      (resolveBand(b.value, bands) || 'var(--accent)') + ';height:' + pct.toFixed(1) + '%;';
    bar.textContent = '';
    bodyEl.appendChild(bar);
  }
}

function readCardConfig(container) {
  try { return normalizeBarConfig(JSON.parse(container.dataset.barConfig || '{}')); }
  catch (e) { return normalizeBarConfig({}); }
}

/** Fetch history for one card and repaint it. Bucket stays client-side. */
export async function refreshOneBarCard(container) {
  const cfg = readCardConfig(container);
  const titleEl = container.querySelector('.bar-single-title');
  const bodyEl = container.querySelector('.bar-single-body');
  const statusEl = container.querySelector('.bar-single-status');
  if (!bodyEl || !statusEl) return;
  if (titleEl) titleEl.textContent = cfg.metric || 'Bar Card';
  if (!cfg.metric) {
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    statusEl.textContent = NO_METRIC_TEXT;
    statusEl.style.display = '';
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
  const capped = bucketizeCapped(points, bucketToMs(cfg.bucket), 'avg');
  const bands = bandsForValues(capped.bars.map(function (b) { return b.value; }), cfg);
  renderBars(bodyEl, statusEl, capped.bars, bands);
}

/** Refresh every bar-single card on the page (updater dispatch target). */
export async function refreshBarSingleCard() {
  const nodes = document.querySelectorAll('.bar-single-card');
  for (const node of nodes) {
    try { await refreshOneBarCard(node); } catch (e) { /* per-card failure stays local */ }
  }
}

/** Live-state push entry point (called by updateWithState). */
export function updateBarSingleCardFromState(state) {
  if (state) refreshBarSingleCard();
}
