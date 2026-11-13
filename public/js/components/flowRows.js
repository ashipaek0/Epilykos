/**
 * Flow rows card (type key `flow-rows`): a row per destination (or source) of energy, each with its label, a bar and its
 * value, on one line (label, bar, value), for "where it's going": the battery, the home, the grid. A row whose power is
 * below a small limit shows a word such as "Idle" instead of a value, and its bar shrinks to a short grey stub.
 *
 * A bar fills against the row's own highest value, or, when that is empty, against the largest row, so the rows compare
 * with each other. A row can count only one direction of a signed reading (`sign`): a battery power that is positive
 * while charging and negative while discharging can be a row that shows only the charging.
 *
 * Block config: { title, decimals (0 to 3; empty: automatic), idleBelow, idleText, showBars, rows: [{ label, metric, unit, color, sign, max }] }
 *   idleBelow is in watts for a W or kW reading, and in the reading's own unit for any other.
 *
 * @module components/flowRows
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';
import { decimalOpts, decimalsOption, hexColor, num, word } from './cardText.js';

export const MAX_ROWS = 8;
export const SIGNS = ['any', 'positive', 'negative'];
export const IDLE_STUB = 6;   // an idle row keeps a short grey stub of its bar, as in the picture this card follows
// As in the picture this card follows: the first bar in the accent colour, the second in the text colour, the third grey.
const PALETTE = ['var(--solar, #f59e0b)', 'var(--text)', 'var(--text-secondary)', 'var(--home, #38bdf8)'];

/** The valid options of a card's config. */
export function flowRowsOptions(config = {}) {
  const rows = (Array.isArray(config.rows) ? config.rows : [])
    .map((r, i) => ({
      label: String((r && r.label) ?? '').trim().slice(0, 40), metric: String((r && r.metric) || '').trim(), unit: String((r && r.unit) || '').trim().slice(0, 12),
      color: hexColor(r && r.color) || PALETTE[i % PALETTE.length], sign: SIGNS.includes(r && r.sign) ? r.sign : 'any', max: Math.max(0, num(r && r.max, 0))
    }))
    .filter(r => r.metric).slice(0, MAX_ROWS);
  return {
    title: word(config.title, '', 60), decimals: decimalsOption(config.decimals), idleBelow: Math.max(0, num(config.idleBelow, 10)), idleText: word(config.idleText, 'Idle', 16),
    showBars: config.showBars !== false, rows
  };
}

/** How much a reading counts for a row: its size in the direction the row follows (0 when it goes the other way), or null without a number. */
export function rowAmount(value, sign) {
  if (!isNumericValue(value)) return null;
  const n = Number(value);
  return sign === 'positive' ? Math.max(0, n) : sign === 'negative' ? Math.max(0, -n) : Math.abs(n);
}

/** Whether an amount counts as idle: below `idleBelow` watts for W and kW readings, below it in the reading's own unit otherwise. */
export function isIdle(amount, unit, idleBelow) {
  if (amount === null) return false;
  return amount < (String(unit).trim() === 'kW' ? idleBelow / 1000 : idleBelow) || amount === 0;
}

/** The bar fills of all rows, 0 to 1: against each row's own highest value, else against the largest amount. */
export function barFractions(amounts, maxes) {
  const largest = Math.max(0, ...amounts.map(a => (a === null ? 0 : a)));
  return amounts.map((a, i) => {
    if (a === null) return 0;
    const full = maxes[i] > 0 ? maxes[i] : largest;
    return full > 0 ? Math.max(0, Math.min(1, a / full)) : 0;
  });
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

export function buildFlowRows(block = {}) {
  const o = flowRowsOptions(block.config || {});
  const card = el('div', 'flow-rows-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.flowRowsCfg = JSON.stringify(o);
  card.classList.toggle('fr-no-bars', !o.showBars);
  card.style.setProperty('--fr-rows', String(Math.max(1, o.rows.length)));
  if (o.title) card.appendChild(el('div', 'fr-title', o.title));
  const list = el('div', 'fr-rows');
  o.rows.forEach((r, i) => {
    const row = el('div', 'fr-row'); row.dataset.row = String(i);
    const bar = el('div', 'fr-bar'); const fill = el('i', 'fr-fill'); fill.style.background = r.color; bar.appendChild(fill);
    row.append(el('span', 'fr-label', r.label || r.metric), bar, el('span', 'fr-value', '—'));
    list.appendChild(row);
  });
  if (!o.rows.length) list.appendChild(el('div', 'fr-empty'));
  card.appendChild(list);
  return card;
}

export function updateFlowRows(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.flow-rows-card').forEach(card => {
    let o; try { o = JSON.parse(card.dataset.flowRowsCfg); } catch (e) { return; }
    const entries = o.rows.map(r => metrics[r.metric]);
    const units = o.rows.map((r, i) => r.unit || (entries[i] && entries[i].unit) || '');
    const amounts = o.rows.map((r, i) => (entries[i] ? rowAmount(entries[i].value, r.sign) : null));
    const fracs = barFractions(amounts, o.rows.map(r => r.max));
    o.rows.forEach((r, i) => {
      const row = card.querySelector(`.fr-row[data-row="${i}"]`);
      if (!row) return;
      const idle = isIdle(amounts[i], units[i], o.idleBelow);
      row.dataset.state = amounts[i] === null ? 'unknown' : idle ? 'idle' : 'active';
      row.querySelector('.fr-value').textContent = amounts[i] === null ? '—' : idle ? o.idleText : formatMetric(amounts[i], units[i], decimalOpts(o.decimals)).text;
      row.querySelector('.fr-fill').style.width = (idle ? IDLE_STUB : fracs[i] * 100).toFixed(1) + '%';
    });
  });
}
