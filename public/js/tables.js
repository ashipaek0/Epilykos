export async function updateDailyTable() {
  const tbody = document.getElementById('daily-table-body');
  if (!tbody) return;
  try {
    const res = await fetch('/api/daily?days=30');
    const data = await res.json();
    console.log('Daily table data:', data); // Debug: inspect in browser console
    tbody.innerHTML = '';
    if (!data || data.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="7" style="text-align:center;">No data available</td>';
      tbody.appendChild(tr);
      return;
    }
    data.reverse().forEach(row => {
      const date = new Date(row.day + 'T00:00:00');
      const formattedDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formattedDate}</td>
        <td>${(row.consumption_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.solar_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.battery_charge_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.battery_discharge_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.grid_import_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.grid_export_kwh || 0).toFixed(1)} kWh</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Daily table error:', e);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">Failed to load data</td></tr>';
  }
}

export async function updateMonthlyTable() {
  const tbody = document.getElementById('monthly-table-body');
  if (!tbody) return;
  try {
    const res = await fetch('/api/monthly');
    const data = await res.json();
    console.log('Monthly table data:', data);
    tbody.innerHTML = '';
    if (!data || data.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="7" style="text-align:center;">No data available</td>';
      tbody.appendChild(tr);
      return;
    }
    data.reverse().forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.month || '--'}</td>
        <td>${(row.consumption_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.solar_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.battery_charge_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.battery_discharge_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.grid_import_kwh || 0).toFixed(1)} kWh</td>
        <td>${(row.grid_export_kwh || 0).toFixed(1)} kWh</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Monthly table error:', e);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">Failed to load data</td></tr>';
  }
}
