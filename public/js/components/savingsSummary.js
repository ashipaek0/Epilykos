import { uid } from '../utils/uid.js';
import { escapeHtml } from '../utils.js';
import { formatMoney, formatMoneyShort } from './format.js';

/**
 * The periods a savings card can show, with the config key that turns each
 * on. Year is off unless chosen; the others are on unless turned off, as
 * they were before the choice existed.
 */
export const SAVINGS_PERIODS = [
  { key: 'today', label: 'Today', option: 'showToday' },
  { key: 'week', label: 'This week', option: 'showWeek' },
  { key: 'month', label: 'This month', option: 'showMonth' },
  { key: 'year', label: 'This year', option: 'showYear', off: true },
  { key: 'all', label: 'All time', option: 'showAll' },
];

export function savingsPeriodShown(config, p) {
  return p.off ? config[p.option] === true : config[p.option] !== false;
}

/** Savings today / this week / this month / this year / all time. */
export function buildSavingsSummary(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const title = config.title || 'Savings';
  const metric = (config.savings_metric || '').trim();
  const container = document.createElement('div');
  container.className = 'savings-block-container ep-card';
  container.dataset.blockId = id;
  container.dataset.savingsMetric = metric;
  const shown = SAVINGS_PERIODS.filter(p => savingsPeriodShown(config, p));
  const tiles = shown
    .map(p => `<div class="stat-card ep-tile"><div class="stat-label ep-label">${p.label}</div><div class="stat-value ep-value is-empty" id="${uid('savings-' + p.key, id)}"><span class="ep-num">—</span></div></div>`)
    .join('');
  container.innerHTML = `<h3 class="ep-card-title">${escapeHtml(title)}</h3><div class="stats-grid ep-tiles" data-count="${shown.length}">${tiles}</div>`;
  return container;
}

export function updateSavingsFromState(state) {
  if (!state || !state.savings) return;
  const s = state.savings, curr = s.currency || '€';
  const rate = s.rate || 0.30;
  const metrics = state.metrics || {};
  document.querySelectorAll('.savings-block-container').forEach(c => {
    const id = c.dataset.blockId || '';
    const metric = c.dataset.savingsMetric || '';
    let today = s.today;
    // A chosen solar-energy metric overrides today only; the longer periods
    // stay server-computed.
    if (metric && metrics[metric] && metrics[metric].value > 0) today = metrics[metric].value * rate;
    for (const { key } of SAVINGS_PERIODS) {
      const e = document.getElementById(uid('savings-' + key, id));
      if (!e) continue;
      const v = key === 'today' ? today : s[key];
      e.textContent = formatMoneyShort(v, curr);
      e.title = typeof v === 'number' ? formatMoney(v, curr) : '';
      e.classList.toggle('is-empty', typeof v !== 'number');
    }
  });
}
