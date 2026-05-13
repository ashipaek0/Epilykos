export function buildDataTableMonthly() {
  const container = document.createElement('div');
  container.className = 'daily-breakdown-container';
  container.innerHTML = `
    <div class="daily-breakdown-header"><h3>Last 12 Months</h3><button class="toggle-btn">▼</button></div>
    <div class="daily-breakdown-content"><div class="daily-table-wrapper"><table class="energy-table"><thead><tr><th>Month</th><th>Load</th><th>Solar PV</th><th>Battery charged</th><th>Battery discharged</th><th>Grid used</th><th>Grid exported</th></tr></thead><tbody id="monthly-table-body"></tbody></table></div></div>
  `;
  return container;
}
