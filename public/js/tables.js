const DEFAULT_COLUMNS = [
  { field: 'consumption_kwh', label: 'Load (kWh)' },
  { field: 'solar_kwh', label: 'Solar PV (kWh)' },
  { field: 'battery_charge_kwh', label: 'Battery charged (kWh)' },
  { field: 'battery_discharge_kwh', label: 'Battery discharged (kWh)' },
  { field: 'grid_import_kwh', label: 'Grid used (kWh)' },
  { field: 'grid_export_kwh', label: 'Grid exported (kWh)' }
];

function getColumns(container) {
  try {
    const cfg = JSON.parse(container.dataset.tableConfig || '{}');
    return cfg.columns || DEFAULT_COLUMNS;
  } catch (e) {
    return DEFAULT_COLUMNS;
  }
}

export async function updateDailyTable() {
  const tbody = document.getElementById('daily-table-body');
  if (!tbody) return;
  const container = tbody.closest('.daily-breakdown-container');
  const cols = container ? getColumns(container) : DEFAULT_COLUMNS;

  try {
    const res = await fetch('/api/daily?days=30');
    const data = await res.json();
    tbody.innerHTML = '';
    if (!data || data.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${1 + cols.length}" style="text-align:center;">No data available</td>`;
      tbody.appendChild(tr);
      return;
    }
    data.reverse().forEach(row => {
      const date = new Date(row.day + 'T00:00:00');
      const formattedDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const cells = cols.map(col => `<td>${(row[col.field] || 0).toFixed(1)} kWh</td>`).join('');
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formattedDate}</td>${cells}`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Daily table error:', e);
    tbody.innerHTML = `<tr><td colspan="${1 + cols.length}" style="text-align:center;color:#ef4444;">Failed to load data</td></tr>`;
  }
}

export async function updateMonthlyTable() {
  const tbody = document.getElementById('monthly-table-body');
  if (!tbody) return;
  const container = tbody.closest('.daily-breakdown-container');
  const cols = container ? getColumns(container) : DEFAULT_COLUMNS;

  try {
    const res = await fetch('/api/monthly');
    const data = await res.json();
    tbody.innerHTML = '';
    if (!data || data.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${1 + cols.length}" style="text-align:center;">No data available</td>`;
      tbody.appendChild(tr);
      return;
    }
    data.reverse().forEach(row => {
      const cells = cols.map(col => `<td>${(row[col.field] || 0).toFixed(1)} kWh</td>`).join('');
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.month || '--'}</td>${cells}`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Monthly table error:', e);
    tbody.innerHTML = `<tr><td colspan="${1 + cols.length}" style="text-align:center;color:#ef4444;">Failed to load data</td></tr>`;
  }
}
