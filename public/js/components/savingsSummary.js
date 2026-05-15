export function buildSavingsSummary(block = {}) {
  const config = block.config || {};
  const title = config.title || 'Savings Summary';
  const showToday = config.showToday !== false;
  const showWeek = config.showWeek !== false;
  const showMonth = config.showMonth !== false;
  const showAll = config.showAll !== false;

  const container = document.createElement('div');
  container.className = 'savings-block-container';
  
  // Optional block title
  if (title) {
    const titleEl = document.createElement('h3');
    titleEl.textContent = title;
    titleEl.style.margin = '0 0 0.5rem 0';
    titleEl.style.fontSize = '1.25rem';
    titleEl.style.fontWeight = '600';
    titleEl.style.color = 'var(--text)';
    container.appendChild(titleEl);
  }
  
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.id = 'savings-summary-row';
  
  // Create cards only if enabled in config
  if (showToday) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.id = 'savings-today-card';
    card.innerHTML = `<div class="stat-label">PV Savings Today</div><div class="stat-value" id="savings-today">--</div>`;
    grid.appendChild(card);
  }
  if (showWeek) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.id = 'savings-week-card';
    card.innerHTML = `<div class="stat-label">PV Savings This Week</div><div class="stat-value" id="savings-week">--</div>`;
    grid.appendChild(card);
  }
  if (showMonth) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.id = 'savings-month-card';
    card.innerHTML = `<div class="stat-label">PV Savings This Month</div><div class="stat-value" id="savings-month">--</div>`;
    grid.appendChild(card);
  }
  if (showAll) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.id = 'savings-all-card';
    card.innerHTML = `<div class="stat-label">PV Savings All-Time</div><div class="stat-value" id="savings-all">--</div>`;
    grid.appendChild(card);
  }
  
  container.appendChild(grid);
  return container;
}

export function updateSavingsFromState(state) {
  if (!state || !state.savings) return;
  const s = state.savings;
  const curr = s.currency || '€';
  const format = (val) => curr + ' ' + Math.round(val).toLocaleString();
  
  const todayEl = document.getElementById('savings-today');
  if (todayEl) todayEl.textContent = format(s.today);
  const weekEl = document.getElementById('savings-week');
  if (weekEl) weekEl.textContent = format(s.week);
  const monthEl = document.getElementById('savings-month');
  if (monthEl) monthEl.textContent = format(s.month);
  const allEl = document.getElementById('savings-all');
  if (allEl) allEl.textContent = format(s.all);
}
