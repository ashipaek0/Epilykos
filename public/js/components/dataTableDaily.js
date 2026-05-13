export function buildDataTableDaily() {
  const container = document.createElement('div');
  container.className = 'daily-breakdown-container';
  container.style.marginBottom = '1rem';
  container.innerHTML = `
    <div class="daily-breakdown-header"><h3>Last 30 Days</h3><button class="toggle-btn">▼</button></div>
    <div class="daily-breakdown-content"><div class="daily-table-wrapper"><table class="energy-table"><thead><tr><th>Date</th><th>Load</th><th>Solar PV</th><th>Battery charged</th><th>Battery discharged</th><th>Grid used</th><th>Grid exported</th></tr></thead><tbody id="daily-table-body"></tbody></table></div></div>
  `;
  return container;
}
