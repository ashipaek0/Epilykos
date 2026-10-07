import { escapeHtml } from '../utils.js';
import { formatEntry, renderValue } from './format.js';
import { markBreakdown, applyBreakdowns } from './breakdown.js';
import { emptyBlock } from './emptyState.js';

/** Several labelled values side by side (wrapping to rows when narrow). */
export function buildMultiValueCard(block = {}) {
  const config = block.config || {};
  const metrics = config.metrics || [];
  if (!metrics.some(m => m && m.metric)) return emptyBlock('Choose the metrics for this block in the layout editor.', block.id);
  const container = document.createElement('div');
  container.className = 'multi-value-card ep-tiles';
  container.dataset.metricMap = JSON.stringify(metrics);
  container.dataset.blockId = block.id;
  markBreakdown(container, config);

  (metrics.length ? metrics : [{ label: '', metric: '', unit: '' }]).forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'stat-card ep-tile';
    card.dataset.mvidx = i;
    card.innerHTML = `<div class="stat-label ep-label">${escapeHtml(m.label || m.metric || 'Value')}</div><div class="stat-value ep-value is-empty" data-metric="${escapeHtml(m.metric || '')}"><span class="ep-num">—</span></div>`;
    container.appendChild(card);
  });
  return container;
}

export function updateMultiValueCard(state) {
  document.querySelectorAll('.multi-value-card').forEach(container => {
    let metrics; try { metrics = JSON.parse(container.dataset.metricMap); } catch (e) { return; }
    const m = state.metrics || {};
    const cards = container.querySelectorAll('.stat-card');
    applyBreakdowns(container, state, metrics.map((cfg, i) => ({ host: cards[i], title: cfg.label || cfg.metric, specs: [{ name: cfg.metric, unit: cfg.unit }] })));
    metrics.forEach((cfg, i) => {
      if (!cfg.metric || !cards[i]) return;
      const entry = m[cfg.metric];
      if (!entry || entry.value === undefined || entry.value === null) return;
      renderValue(cards[i].querySelector('.stat-value'), formatEntry(entry, cfg.unit, cfg.metric));
    });
  });
}
