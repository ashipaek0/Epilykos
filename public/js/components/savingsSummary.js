import { uid } from '../utils/uid.js';

export function buildSavingsSummary(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const title = config.title || '';
  const metric = (config.savings_metric || '').trim();
  const container = document.createElement('div');
  container.className = 'savings-block-container';
  container.dataset.blockId = id;
  container.dataset.savingsMetric = metric;
  if (title) { const h = document.createElement('h3'); h.textContent = title; h.style.margin = '0 0 0.5rem 0'; container.appendChild(h); }
  const grid = document.createElement('div'); grid.className = 'stats-grid';
  const add = (label, suffix) => { if (config[`show${suffix}`] !== false) { const c = document.createElement('div'); c.className = 'stat-card'; c.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value" id="${uid('savings-'+suffix.toLowerCase(), id)}">--</div>`; grid.appendChild(c); } };
  add('PV Savings Today', 'Today'); add('PV Savings This Week', 'Week'); add('PV Savings This Month', 'Month'); add('PV Savings All-Time', 'All');
  container.appendChild(grid); return container;
}

export function updateSavingsFromState(state) {
  if (!state || !state.savings) return;
  const s = state.savings, curr = s.currency || '€';
  const rate = s.rate || 0.30;
  const metrics = state.metrics || {};
  document.querySelectorAll('.savings-block-container').forEach(c => {
    const id = c.dataset.blockId || '';
    const metric = c.dataset.savingsMetric || '';
    let today = s.today, week = s.week, month = s.month, all = s.all;
    if (metric && metrics[metric] && metrics[metric].value > 0) {
      const val = metrics[metric].value;
      today = val * rate;
      week = val * rate;
      month = val * rate;
      all = val * rate;
    }
    const fmt = (v) => curr + ' ' + Math.round(v).toLocaleString();
    [['savings-today',today],['savings-week',week],['savings-month',month],['savings-all',all]].forEach(([k,v]) => { const e = document.getElementById(uid(k,id)); if (e) e.textContent = fmt(v); });
  });
}
