import { escapeHtml } from '../utils.js';
import { formatEntry, renderValue } from './format.js';
import { markBreakdown, applyBreakdowns } from './breakdown.js';

/** A row of large single values. Each tile: label above, value with unit. */
export function buildMetricCards(block) {
  if (!block.cards || !block.cards.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'ep-card ep-card-empty';
    placeholder.textContent = 'Choose metrics for this block in the layout editor.';
    return placeholder;
  }
  const grid = document.createElement('div');
  grid.className = 'stats-grid ep-tiles';
  grid.dataset.blockId = block.id || '';
  markBreakdown(grid, block.config);
  // The tiles' config travels with the element, so updates need no page state.
  grid.dataset.cards = JSON.stringify(block.cards.map(c => ({ metric: c.metric || '', unit: c.unit || '' })));
  block.cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'stat-card ep-tile';
    cardEl.dataset.metric = card.metric || '';
    cardEl.innerHTML = `<div class="stat-label ep-label">${escapeHtml(card.title || card.metric || '')}</div><div class="stat-value ep-value is-empty"><span class="ep-num">—</span></div>`;
    grid.appendChild(cardEl);
  });
  return grid;
}

export function updateMetricCardsFromState(state) {
  if (!state || !state.metrics) return;
  document.querySelectorAll('.stats-grid[data-cards]').forEach(grid => {
    let cards;
    try { cards = JSON.parse(grid.dataset.cards); } catch (e) { return; }
    const tiles = grid.querySelectorAll('.stat-card');
    applyBreakdowns(grid, state, cards.map((card, i) => ({ host: tiles[i], title: tiles[i]?.querySelector('.ep-label')?.textContent || card.metric, specs: [{ name: card.metric, unit: card.unit }] })));
    cards.forEach((card, i) => {
      if (!card.metric || !tiles[i]) return;
      const entry = state.metrics[card.metric];
      if (!entry) return;
      renderValue(tiles[i].querySelector('.stat-value'), formatEntry(entry, card.unit, card.metric));
    });
  });
}
