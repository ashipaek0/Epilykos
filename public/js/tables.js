export async function updateDailyTable() {
  const tbody = document.getElementById('daily-table-body');
  if (!tbody) return;
  try {
    const res = await fetch('/api/daily?days=30');
    const data = await res.json();
    tbody.innerHTML = '';
    data.reverse().forEach(row => {
      const date = new Date(row.day + 'T00:00:00');
      const formattedDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formattedDate}</td>
        <td>${row.consumption_kwh.toFixed(1)} kWh</td>
        <td>${row.solar_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_charge_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_discharge_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_import_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_export_kwh.toFixed(1)} kWh</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

export async function updateMonthlyTable() {
  const tbody = document.getElementById('monthly-table-body');
  if (!tbody) return;
  try {
    const res = await fetch('/api/monthly');
    const data = await res.json();
    tbody.innerHTML = '';
    data.reverse().forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.month}</td>
        <td>${row.consumption_kwh.toFixed(1)} kWh</td>
        <td>${row.solar_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_charge_kwh.toFixed(1)} kWh</td>
        <td>${row.battery_discharge_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_import_kwh.toFixed(1)} kWh</td>
        <td>${row.grid_export_kwh.toFixed(1)} kWh</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}
