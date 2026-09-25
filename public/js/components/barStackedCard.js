/**
 * barStackedCard — stacked multi-metric vertical bar card (type key `bar-stacked`).
 *
 * Slice 2 scope: N series (label + metric + per-metric color), one stacked
 * column per shared time bucket. Bucket edges are shared across series: each
 * series is bucketized independently (per-card agg, default 'avg') on the
 * UNION of timestamps, so series with different cadences still align.
 * Missing series in a bucket renders a zero-height segment (order preserved).
 * A single series degrades to the Slice-1 single-bar look; all series empty
 * renders the empty state. Colours come from the series config, never bands.
 *
 * Data path mirrors barSingleCard: each series fetches its own history with
 * GET /api/metrics/history?metric=&hours= and buckets CLIENT-side.
 * The `bucket` setting never leaves the client as a query param.
 *
 * Block config: { metrics:[{label,metric,color}], range:'24h'|'7d',
 *   bucket:'15m'|'1h'|'1d', agg:'avg'|'sum'|'min'|'max'|'last' }
 * (`series` is accepted as an alias for `metrics` when reading.)
 */
import {
  MAX_BARS,
  WARM_PALETTE,
  normalizeRange,
  normalizeBucket,
  rangeToHours,
  bucketToMs,
  bucketize
} from './barCardLogic.js';

/** Placeholder for a block with no series configured yet. */
export const NO_METRIC_TEXT = 'Configure a metric';

/** Empty state: series configured but no history in range. */
export const EMPTY_TEXT = 'No data available for the selected range';

export const DEFAULT_AGG = 'avg';

const AGG_MODES = ['avg', 'sum', 'min', 'max', 'last'];

/** Validate a per-card agg mode; anything else falls back to 'avg'. */
export function normalizeAgg(agg) {
  return AGG_MODES.indexOf(agg) !== -1 ? agg : DEFAULT_AGG;
}

/** Normalize a raw block config to stacked defaults. */
export function normalizeStackedConfig(raw) {
  const cfg = raw || {};
  const list = Array.isArray(cfg.metrics) ? cfg.metrics
    : (Array.isArray(cfg.series) ? cfg.series : []);
  const series = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const metric = s.metric || '';
    if (!metric) continue;
    series.push({
      label: s.label || metric,
      metric: metric,
      color: s.color || WARM_PALETTE[i % WARM_PALETTE.length]
    });
  }
  return {
    series: series,
    range: normalizeRange(cfg.range),
    bucket: normalizeBucket(cfg.bucket),
    agg: normalizeAgg(cfg.agg)
  };
}

/**
 * Stack bucketized series on shared edges.
 * @param {Array<Array>} allPoints - one history array per series
 *   ([{ timestamp (ms epoch), value }, ...]; non-numeric values skipped)
 * @param {number} bucketMs - bucket width in ms
 * @param {string} [agg='avg'] - per-card agg mode applied to every series
 * @returns {{ edges:Array<number>, rows:Array<{t:number,values:Array<number>,total:number}>, bucketMs:number }}
 *   edges are the UNION of per-series bucket starts, sorted; a series with
 *   no points in a bucket contributes 0, so every row's values array stays
 *   in series order and total === sum(values) (sum preservation).
 */
export function stackSeries(allPoints, bucketMs, agg) {
  const ms = Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : bucketToMs('1h');
  const mode = agg || DEFAULT_AGG;
  const per = (Array.isArray(allPoints) ? allPoints : []).map(function (pts) {
    const bars = bucketize(pts || [], ms, mode);
    const m = new Map();
    for (const b of bars) m.set(b.t, b.value);
    return m;
  });
  const edgeSet = new Set();
  for (const m of per) {
    for (const t of m.keys()) edgeSet.add(t);
  }
  const edges = Array.from(edgeSet).sort(function (a, b) { return a - b; });
  const rows = edges.map(function (t) {
    const values = per.map(function (m) { return m.has(t) ? m.get(t) : 0; });
    return {
      t: t,
      values: values,
      total: values.reduce(function (a, b) { return a + b; }, 0)
    };
  });
  return { edges: edges, rows: rows, bucketMs: ms };
}

/**
 * Stack with the DOM cap applied: while the column count exceeds MAX_BARS
 * the bucket width is doubled (same coarsening rule as bucketizeCapped).
 * @returns {{ edges, rows, bucketMs, coarsened }}
 */
export function stackSeriesCapped(allPoints, bucketMs, agg) {
  let ms = Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : bucketToMs('1h');
  let r = stackSeries(allPoints, ms, agg);
  let coarsened = false;
  while (r.edges.length > MAX_BARS) {
    ms *= 2;
    coarsened = true;
    r = stackSeries(allPoints, ms, agg);
    if (ms > 366 * 24 * 60 * 60 * 1000) break; // sanity guard, never infinite
  }
  return { edges: r.edges, rows: r.rows, bucketMs: ms, coarsened: coarsened };
}

export function buildBarStackedCard(block) {
  block = block || {};
  const cfg = normalizeStackedConfig(block.config);
  const container = document.createElement('div');
  container.className = 'bar-stacked-card stat-card';
  container.dataset.blockId = block.id || '';
  // The refresher re-reads config off the live DOM node, same convention as
  // barSingleCard: a config change only needs a re-render.
  container.dataset.barStackedConfig = JSON.stringify(cfg);
  container.style.cssText = 'min-width:0;max-width:100%;box-sizing:border-box;overflow:hidden;height:100%;';

  const titleEl = document.createElement('div');
  titleEl.className = 'stat-label bar-stacked-title';
  titleEl.textContent = cfg.series.length
    ? cfg.series.map(function (s) { return s.label; }).join(' + ')
    : 'Stacked Bars';
  container.appendChild(titleEl);

  const legendEl = document.createElement('div');
  legendEl.className = 'bar-stacked-legend';
  legendEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.5rem;font-size:0.8rem;margin-bottom:0.25rem;';
  container.appendChild(legendEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'bar-stacked-body';
  bodyEl.style.cssText = 'display:flex;align-items:flex-end;gap:2px;min-height:80px;';
  container.appendChild(bodyEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'bar-stacked-status';
  statusEl.style.cssText = 'color:var(--text-secondary);font-style:italic;';
  statusEl.textContent = cfg.series.length ? EMPTY_TEXT : NO_METRIC_TEXT;
  container.appendChild(statusEl);

  return container;
}

/**
 * Render stacked columns into the card body. One column per shared bucket
 * edge; one segment per series in config order (missing = zero height).
 * Segment colour is the series colour passthrough. textContent only.
 */
export function renderStackedBars(bodyEl, statusEl, legendEl, stacked, series) {
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  if (legendEl) {
    while (legendEl.firstChild) legendEl.removeChild(legendEl.firstChild);
    (series || []).forEach(function (s) {
      const item = document.createElement('span');
      item.className = 'bar-stacked-legend-item';
      const dot = document.createElement('span');
      dot.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:2px;background:' +
        (s.color || 'var(--accent)') + ';margin-right:4px;';
      dot.textContent = '';
      item.appendChild(dot);
      const lab = document.createElement('span');
      lab.textContent = s.label || s.metric || '';
      item.appendChild(lab);
      legendEl.appendChild(item);
    });
  }
  const rows = (stacked && stacked.rows) || [];
  if (!rows.length) {
    statusEl.textContent = EMPTY_TEXT;
    statusEl.style.display = '';
    return;
  }
  statusEl.textContent = '';
  statusEl.style.display = 'none';
  let max = 0;
  for (const r of rows) { if (r.total > max) max = r.total; }
  if (!(max > 0)) max = 1;
  const n = Math.min(rows.length, MAX_BARS);
  const count = (series || []).length;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const col = document.createElement('div');
    col.className = 'bar-stacked-col';
    const colPct = Math.max(0, Math.min(100, (r.total / max) * 100));
    col.style.cssText = 'flex:1 1 0;min-width:2px;display:flex;flex-direction:column;justify-content:flex-end;height:' +
      colPct.toFixed(1) + '%;';
    col.textContent = '';
    for (let k = 0; k < count; k++) {
      const v = r.values[k] || 0;
      const seg = document.createElement('div');
      seg.className = 'bar-stacked-seg';
      const h = r.total > 0 ? (v / r.total) * 100 : 0;
      seg.style.cssText = 'width:100%;background:' +
        ((series[k] && series[k].color) || 'var(--accent)') + ';height:' + h.toFixed(1) + '%;';
      seg.textContent = '';
      col.appendChild(seg);
    }
    bodyEl.appendChild(col);
  }
}

function readStackedConfig(container) {
  try { return normalizeStackedConfig(JSON.parse(container.dataset.barStackedConfig || '{}')); }
  catch (e) { return normalizeStackedConfig({}); }
}

/** Fetch history for every series and repaint one card. Bucket stays client-side. */
export async function refreshOneBarStackedCard(container) {
  const cfg = readStackedConfig(container);
  const titleEl = container.querySelector('.bar-stacked-title');
  const legendEl = container.querySelector('.bar-stacked-legend');
  const bodyEl = container.querySelector('.bar-stacked-body');
  const statusEl = container.querySelector('.bar-stacked-status');
  if (!bodyEl || !statusEl) return;
  if (titleEl) {
    titleEl.textContent = cfg.series.length
      ? cfg.series.map(function (s) { return s.label; }).join(' + ')
      : 'Stacked Bars';
  }
  if (!cfg.series.length) {
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    if (legendEl) { while (legendEl.firstChild) legendEl.removeChild(legendEl.firstChild); }
    statusEl.textContent = NO_METRIC_TEXT;
    statusEl.style.display = '';
    return;
  }
  const hours = rangeToHours(cfg.range);
  const allPoints = [];
  for (const s of cfg.series) {
    let points = [];
    try {
      const r = await fetch('/api/metrics/history?metric=' + encodeURIComponent(s.metric) + '&hours=' + hours);
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr)) points = arr;
      }
    } catch (e) { points = []; }
    allPoints.push(points);
  }
  const stacked = stackSeriesCapped(allPoints, bucketToMs(cfg.bucket), cfg.agg);
  renderStackedBars(bodyEl, statusEl, legendEl, stacked, cfg.series);
}

/** Refresh every bar-stacked card on the page (updater dispatch target). */
export async function refreshBarStackedCard() {
  const nodes = document.querySelectorAll('.bar-stacked-card');
  for (const node of nodes) {
    try { await refreshOneBarStackedCard(node); } catch (e) { /* per-card failure stays local */ }
  }
}

/** Live-state push entry point (called by updateWithState). */
export function updateBarStackedCardFromState(state) {
  if (state) refreshBarStackedCard();
}
