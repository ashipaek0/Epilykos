/**
 * Quick actions (Controls page): one card holding a row of up to six compact buttons, each with
 * its own icon, label, action and colour. Every button is an ordinary Button card (see
 * buttonCard.js) in the compact layout, so taps, live state and colours behave the same.
 *
 * config: { title, items: [{ source, device, entity, metric, action, name, tapAction,
 *                            icon, iconOff, onColor, offColor }], group }
 */
import { escapeHtml } from '../utils.js';
import { emptyBlock } from './emptyState.js';
import { buildButtonCard } from './buttonCard.js';

export const MAX_QUICK_ACTIONS = 6;

/** The usable buttons of a config: at most six, each with something to control. */
export function quickItems(config = {}) {
  const list = Array.isArray(config.items) ? config.items : [];
  return list.filter(it => it && typeof it === 'object' && it.entity).slice(0, MAX_QUICK_ACTIONS);
}

export function buildQuickActions(block = {}) {
  const config = block.config || {};
  const items = quickItems(config);
  if (!items.length) return emptyBlock('Add up to six buttons to this card in the layout editor.', block.id || '');
  const wrap = document.createElement('div');
  wrap.className = 'quick-actions';
  wrap.dataset.blockId = block.id || '';
  wrap.style.setProperty('--qa-count', String(items.length));
  if (config.title) wrap.insertAdjacentHTML('afterbegin', `<div class="qa-title">${escapeHtml(config.title)}</div>`);
  const row = document.createElement('div');
  row.className = 'qa-row';
  items.forEach((item, i) => {
    const btn = buildButtonCard({
      id: `${block.id || 'qa'}-${i}`,
      type: 'button-card',
      config: Object.assign({ showState: false }, item, { layout: 'compact', pill: false, fill: true, group: '' })
    });
    row.appendChild(btn);
  });
  wrap.appendChild(row);
  return wrap;
}

