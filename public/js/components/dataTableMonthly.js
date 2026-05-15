export function buildDataTableMonthly() {
  const container = document.createElement('div');
  container.className = 'daily-breakdown-container';
  
  const header = document.createElement('div');
  header.className = 'daily-breakdown-header';
  header.innerHTML = `
    <h3>Last 12 Months</h3>
    <button class="toggle-btn">▼</button>
  `;
  
  const content = document.createElement('div');
  content.className = 'daily-breakdown-content collapsed';
  content.innerHTML = `
    <div class="daily-table-wrapper">
      <table class="energy-table">
        <thead>
          <tr>
            <th>Month</th>
            <th>Load (kWh)</th>
            <th>Solar PV (kWh)</th>
            <th>Battery charged (kWh)</th>
            <th>Battery discharged (kWh)</th>
            <th>Grid used (kWh)</th>
            <th>Grid exported (kWh)</th>
          </tr>
        </thead>
        <tbody id="monthly-table-body"></tbody>
      </table>
    </div>
  `;
  
  container.appendChild(header);
  container.appendChild(content);
  
  // Toggle functionality
  const toggleBtn = header.querySelector('.toggle-btn');
  toggleBtn.addEventListener('click', () => {
    const isCollapsed = content.classList.contains('collapsed');
    if (isCollapsed) {
      content.classList.remove('collapsed');
      toggleBtn.textContent = '▲';
    } else {
      content.classList.add('collapsed');
      toggleBtn.textContent = '▼';
    }
  });
  
  return container;
}
