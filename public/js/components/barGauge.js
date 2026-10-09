/**
 * Bar Gauge Card — multi-row horizontal bar visualization for any metric.
 * Each row: label | bar (min→max fill) | value+unit.
 */
import { escapeHtml, isNumericValue } from '../utils.js';
import { formatEntry, renderValue } from './format.js';
import { markBreakdown, applyBreakdowns } from './breakdown.js';
import { emptyBlock } from './emptyState.js';
export function buildBarGauge(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const rows = (config.metrics && config.metrics.length ? config.metrics : [{ label: '', metric: '', unit: '', min: 0, max: 100, color: '' }]);
  if (!rows.some(r => r && r.metric)) return emptyBlock('Choose the metrics for this block in the layout editor.', id);

  const container = document.createElement('div');
  container.className = 'bar-gauge-card ep-card';
  container.dataset.blockId = id;
  markBreakdown(container, config);
  container.dataset.metricMap = JSON.stringify(rows);

  let html = '';
  rows.forEach((r, i) => {
    const fillStyle = r.gradient
      ? `width:0%;background:linear-gradient(to right,${r.gradient});`
      : `width:0%;background:${r.color || 'var(--accent)'};`;
    html += `
      <div class="bar-gauge-row" data-bgidx="${i}">
        <span class="bar-gauge-label">${escapeHtml(r.label || '--')}</span>
        <div class="bar-gauge-track">
          <div class="bar-gauge-fill" id="bg-fill-${id}-${i}" style="${fillStyle}"></div>
        </div>
        <span class="bar-gauge-value" id="bg-val-${id}-${i}" data-metric="${escapeHtml(r.metric || '')}"><span class="ep-num">\u2014</span></span>
      </div>`;
  });
  container.innerHTML = html;
  return container;
}
export function updateBarGauge(state) {
  document.querySelectorAll('.bar-gauge-card').forEach(container => {
    let rows;
    try { rows = JSON.parse(container.dataset.metricMap); } catch (e) { return; }
    const id = container.dataset.blockId || '';
    const m = state.metrics || {};
    applyBreakdowns(container, state, rows.map((cfg, i) => ({ host: container.querySelector(`.bar-gauge-row[data-bgidx="${i}"]`), title: cfg.label || cfg.metric, specs: [{ name: cfg.metric, unit: cfg.unit }] })));

    rows.forEach((cfg, i) => {
      if (!cfg.metric) return;
      const entry = m[cfg.metric];
      const v = entry?.value;
      if (v === undefined || v === null) return;

      const min = cfg.min ?? 0;
      const max = cfg.max ?? 100;
      const range = max - min;
      const pct = (isNumericValue(v) && range > 0) ? Math.min(100, Math.max(0, ((v - min) / range) * 100)) : 0;

      const fill = document.getElementById(`bg-fill-${id}-${i}`);
      if (fill) fill.style.width = pct + '%';

      const val = document.getElementById(`bg-val-${id}-${i}`);
      // D6 (non-numeric: explicit units only) is handled by formatEntry.
      renderValue(val, formatEntry(entry, cfg.unit, cfg.metric));
    });
  });
}

