export function buildSavingsSummary() {
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.id = 'savings-summary-row';
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-label">PV Savings Today</div><div class="stat-value" id="savings-today">--</div></div>
    <div class="stat-card"><div class="stat-label">PV Savings This Week</div><div class="stat-value" id="savings-week">--</div></div>
    <div class="stat-card"><div class="stat-label">PV Savings This Month</div><div class="stat-value" id="savings-month">--</div></div>
    <div class="stat-card"><div class="stat-label">PV Savings All-Time</div><div class="stat-value" id="savings-all">--</div></div>
  `;
  return grid;
}

export function updateSavingsFromState(state) {
  if (!state || !state.savings) return;
  const s = state.savings;
  const curr = s.currency || '€';
  const format = (val) => curr + ' ' + Math.round(val).toLocaleString();
  document.getElementById('savings-today').textContent = format(s.today);
  document.getElementById('savings-week').textContent = format(s.week);
  document.getElementById('savings-month').textContent = format(s.month);
  document.getElementById('savings-all').textContent = format(s.all);
}
