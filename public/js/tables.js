const DEFAULT_COLUMNS = [{ field: 'consumption_kwh', label: 'Load (kWh)' }, { field: 'solar_kwh', label: 'Solar PV (kWh)' }, { field: 'battery_charge_kwh', label: 'Battery charged (kWh)' }, { field: 'battery_discharge_kwh', label: 'Battery discharged (kWh)' }, { field: 'grid_import_kwh', label: 'Grid used (kWh)' }, { field: 'grid_export_kwh', label: 'Grid exported (kWh)' }];
function getColumns(c) { try { const cfg = JSON.parse(c.dataset.tableConfig || '{}'); return cfg.columns || DEFAULT_COLUMNS; } catch (e) { return DEFAULT_COLUMNS; } }

export async function updateDailyTable() {
  const containers = document.querySelectorAll('.daily-breakdown-container');
  if (!containers.length) return;
  const res = await fetch('/api/daily?days=30');
  if (!res.ok) return;
  const data = await res.json();
  for (const c of containers) {
    const id = c.dataset.blockId || '';
    const tbody = document.getElementById(id ? `daily-table-body-${id}` : 'daily-table-body');
    if (!tbody) continue;
    const cols = getColumns(c);
    tbody.innerHTML = '';
    if (!data || !data.length) { tbody.innerHTML = `<tr><td colspan="${1+cols.length}" style="text-align:center;">No data available</td></tr>`; continue; }
    data.reverse().forEach(row => { const date = new Date(row.day + 'T00:00:00'), fd = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), cells = cols.map(col => `<td>${(row[col.field] || 0).toFixed(1)} kWh</td>`).join(''); tbody.insertAdjacentHTML('beforeend', `<tr><td>${fd}</td>${cells}</tr>`); });
  }
}

export async function updateMonthlyTable() {
  const containers = document.querySelectorAll('.daily-breakdown-container');
  if (!containers.length) return;
  const res = await fetch('/api/monthly');
  if (!res.ok) return;
  const data = await res.json();
  for (const c of containers) {
    const id = c.dataset.blockId || '';
    const tbody = document.getElementById(id ? `monthly-table-body-${id}` : 'monthly-table-body');
    if (!tbody) continue;
    const cols = getColumns(c);
    tbody.innerHTML = '';
    if (!data || !data.length) { tbody.innerHTML = `<tr><td colspan="${1+cols.length}" style="text-align:center;">No data available</td></tr>`; continue; }
    data.reverse().forEach(row => { const monthEsc = document.createElement('div'); monthEsc.textContent = row.month||'--'; const cells = cols.map(col => `<td>${(row[col.field] || 0).toFixed(1)} kWh</td>`).join(''); tbody.insertAdjacentHTML('beforeend', `<tr><td>${monthEsc.innerHTML}</td>${cells}</tr>`); });
  }
}
