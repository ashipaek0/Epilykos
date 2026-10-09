/**
 * What the dashboard and layout editor show in place of a switch or selector
 * card: those controls work only on the signed-in Controls page, where a
 * change needs the password again and is logged. The placeholder keeps the
 * layout's shape and names the control, with a link there.
 *
 * @module components/controlPlaceholder
 */
import { escapeHtml } from '../utils.js';

export function buildControlPlaceholder(block = {}) {
  const config = block.config || {};
  const el = document.createElement('div');
  el.className = 'ep-card control-placeholder';
  if (block.id) el.dataset.blockId = block.id;
  const name = config.label || config.entity || (block.type === 'state-select' ? 'State select' : 'Switch');
  el.innerHTML = `<div class="control-placeholder-name">${escapeHtml(name)}</div>`
    + '<p class="control-placeholder-text">This control works on the Controls page. <a href="/controls">Open Controls</a></p>';
  return el;
}
