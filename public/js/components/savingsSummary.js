import { uid } from '../utils/uid.js';
import { escapeHtml } from '../utils.js';
import { formatMoney } from './format.js';

/** Savings today / this week / this month / all time. */
export function buildSavingsSummary(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const title = config.title || 'Savings';
  const metric = (config.savings_metric || '').trim();
  const container = document.createElement('div');
  container.className = 'savings-block-container ep-card';
  container.dataset.blockId = id;
  container.dataset.savingsMetric = metric;
  const tiles = [['Today', 'Today'], ['This week', 'Week'], ['This month', 'Month'], ['All time', 'All']]
    .filter(([, suffix]) => config[`show${suffix}`] !== false)
    .map(([label, suffix]) => `<div class="stat-card ep-tile"><div class="stat-label ep-label">${label}</div><div class="stat-value ep-value is-empty" id="${uid('savings-' + suffix.toLowerCase(), id)}"><span class="ep-num">—</span></div></div>`)
    .join('');
  container.innerHTML = `<h3 class="ep-card-title">${escapeHtml(title)}</h3><div class="stats-grid ep-tiles">${tiles}</div>`;
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
    // A chosen solar-energy metric overrides today only; week, month and
    // all-time stay server-computed.
    if (metric && metrics[metric] && metrics[metric].value > 0) today = metrics[metric].value * rate;
    [['savings-today', today], ['savings-week', s.week], ['savings-month', s.month], ['savings-all', s.all]].forEach(([k, v]) => {
      const e = document.getElementById(uid(k, id));
      if (!e) return;
      e.textContent = formatMoney(v, curr);
      e.classList.toggle('is-empty', typeof v !== 'number');
    });
  });
}
