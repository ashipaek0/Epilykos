export function buildDataTableMonthly(block = {}) {
  const config = block.config || {};
  const columns = config.columns || [
    { field: 'consumption_kwh', label: 'Load (kWh)' },
    { field: 'solar_kwh', label: 'Solar PV (kWh)' },
    { field: 'battery_charge_kwh', label: 'Battery charged (kWh)' },
    { field: 'battery_discharge_kwh', label: 'Battery discharged (kWh)' },
    { field: 'grid_import_kwh', label: 'Grid used (kWh)' },
    { field: 'grid_export_kwh', label: 'Grid exported (kWh)' }
  ];

  const container = document.createElement('div');
  container.className = 'daily-breakdown-container';
  container.dataset.tableConfig = JSON.stringify({ columns });

  const header = document.createElement('div');
  header.className = 'daily-breakdown-header';
  header.innerHTML = `
    <h3>${escapeHtml(config.title || 'Last 12 Months')}</h3>
    <button class="toggle-btn">▲</button>
  `;

  const content = document.createElement('div');
  content.className = 'daily-breakdown-content';

  const thHtml = columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join('');

  content.innerHTML = `
    <div class="daily-table-wrapper">
      <table class="energy-table">
        <thead>
          <tr>
            <th>Month</th>
            ${thHtml}
          </tr>
        </thead>
        <tbody id="monthly-table-body"></tbody>
      </table>
    </div>
  `;

  container.appendChild(header);
  container.appendChild(content);

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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
