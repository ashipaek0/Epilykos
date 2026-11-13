/**
 * Status list card (type key `status-list`): a row per thing (an appliance, a circuit, a device) with a dot that lights
 * while its metric says it is on, and optionally the value beside it. A row is on when its metric is a "yes" word (on,
 * true, 1, yes, active, running), or when its number is above (or below) a limit you set, such as a load above 10 W.
 *
 * The rows share the card's height and the text follows the row height, so it scales to any size.
 *
 * Block config: { title, showCount, showValue, onColor, countText, onText, offText, rows: [{ label, metric, unit, when, limit, color }] }
 *   countText: the count line, with {on} and {total} (default '{on} of {total} on'); onText / offText: the words for a row that only says on
 *   or off (default On / Off). Every word on the card is a setting, so none is tied to a language.
 *   when: 'on' (a yes word, or any number above 0; the default), 'above' (above `limit`), 'below' (below `limit`)
 *
 * @module components/statusList
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';

export const MAX_ROWS = 12;
export const WHEN = ['on', 'above', 'below'];
const YES = new Set(['on', 'true', '1', 'yes', 'active', 'running', 'open', 'enabled']);
const hexColor = c => (/^#[0-9a-f]{3,8}$/i.test(String(c || '').trim()) ? String(c).trim() : '');
const num = (v, fallback) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? fallback : n; };

/** The valid options of a card's config. */
export function statusOptions(config = {}) {
  const rows = (Array.isArray(config.rows) ? config.rows : [])
    .map(r => ({
      label: String((r && r.label) ?? '').trim().slice(0, 40), metric: String((r && r.metric) || '').trim(), unit: String((r && r.unit) || '').trim().slice(0, 12),
      when: WHEN.includes(r && r.when) ? r.when : 'on', limit: num(r && r.limit, 0), color: hexColor(r && r.color)
    }))
    .filter(r => r.metric || r.label).slice(0, MAX_ROWS);
  const word = (v, fallback, max) => { const t = v == null ? '' : String(v).trim().slice(0, max); return t || fallback; };
  return {
    title: String(config.title || '').trim().slice(0, 60), showCount: config.showCount === true, showValue: config.showValue === true, onColor: hexColor(config.onColor), rows,
    countText: word(config.countText, '{on} of {total} on', 40), onText: word(config.onText, 'On', 16), offText: word(config.offText, 'Off', 16)
  };
}

/** Whether a reading means "on" for a row: true or false, or null when there is no reading. */
export function isOn(value, row) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (isNumericValue(value) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))) {
    const n = Number(value);
    if (row.when === 'above') return n > row.limit;
    if (row.when === 'below') return n < row.limit;
    return n > 0;
  }
  if (row.when !== 'on') return null;   // a number limit cannot judge text
  return YES.has(String(value).trim().toLowerCase());
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

export function buildStatusList(block = {}) {
  const o = statusOptions(block.config || {});
  const card = el('div', 'status-list-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.statusCfg = JSON.stringify(o);
  card.style.setProperty('--sl-rows', String(Math.max(1, o.rows.length)));
  if (o.title || o.showCount) {
    const head = el('div', 'sl-head');
    head.appendChild(el('span', 'sl-title', o.title));
    if (o.showCount) head.appendChild(el('span', 'sl-count'));
    card.appendChild(head);
  }
  const list = el('div', 'sl-rows');
  o.rows.forEach((r, i) => {
    const row = el('div', 'sl-row'); row.dataset.row = String(i);
    row.append(el('i', 'sl-dot'), el('span', 'sl-label', r.label || r.metric), el('span', 'sl-value'));
    list.appendChild(row);
  });
  if (!o.rows.length) list.appendChild(el('div', 'sl-empty'));   // no rows yet: nothing to show (the card settings add them)
  card.appendChild(list);
  return card;
}

export function updateStatusList(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.status-list-card').forEach(card => {
    let o; try { o = JSON.parse(card.dataset.statusCfg); } catch (e) { return; }
    let on = 0, known = 0;
    o.rows.forEach((r, i) => {
      const row = card.querySelector(`.sl-row[data-row="${i}"]`);
      if (!row) return;
      const entry = r.metric ? metrics[r.metric] : undefined;
      const state_ = entry ? isOn(entry.value, r) : null;
      row.dataset.state = state_ === null ? 'unknown' : state_ ? 'on' : 'off';
      const dot = row.querySelector('.sl-dot');
      dot.style.background = state_ ? (r.color || o.onColor || '') : '';
      dot.style.boxShadow = state_ && (r.color || o.onColor) ? `0 0 0.6em ${r.color || o.onColor}` : '';
      if (state_ !== null) { known++; if (state_) on++; }
      const valueEl = row.querySelector('.sl-value');
      // A row that only says on or off, with no unit, shows the word instead of a bare 1 or 0.
      const plain = r.when === 'on' && !(r.unit || (entry && entry.unit));
      valueEl.textContent = o.showValue && entry ? (plain && state_ !== null && (isNumericValue(entry.value) || typeof entry.value === 'boolean') ? (state_ ? o.onText : o.offText) : formatMetric(entry.value, r.unit || entry.unit || '').text) : '';
    });
    const count = card.querySelector('.sl-count');
    if (count) count.textContent = known ? o.countText.replace('{on}', String(on)).replace('{total}', String(known)) : '';
  });
}
