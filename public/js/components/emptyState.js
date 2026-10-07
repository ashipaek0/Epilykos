/**
 * The placeholder a card shows until it has what it needs, in the same words
 * everywhere: what to choose, and where (the layout editor).
 *
 * @module components/emptyState
 */
export const CHOOSE_METRIC = 'Choose a metric for this block in the layout editor.';

export function emptyBlock(message = CHOOSE_METRIC, blockId = '') {
  const el = document.createElement('div');
  el.className = 'ep-card ep-card-empty';
  if (blockId) el.dataset.blockId = blockId;
  el.textContent = message;
  return el;
}
