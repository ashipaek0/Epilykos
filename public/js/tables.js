/**
 * Daily and Monthly tables: kWh per day (last 30 days) or month (last 12).
 *
 * Data: /api/daily?days=30 and /api/monthly. A column whose daily role is a
 * combined total (e.g. solar from two inverters) also carries its parts per
 * row; tables set to show parts (config.breakdown) list them in the cell, or
 * on tap / hover, like the other cards (components/breakdown.js).
 */
import { escapeHtml } from './utils.js';
import { renderBreakdown, treeRows } from './components/breakdown.js';

const DEFAULT_COLUMNS = [{ field: 'consumption_kwh', label: 'Load (kWh)' }, { field: 'solar_kwh', label: 'Solar PV (kWh)' }, { field: 'battery_charge_kwh', label: 'Battery charged (kWh)' }, { field: 'battery_discharge_kwh', label: 'Battery discharged (kWh)' }, { field: 'grid_import_kwh', label: 'Grid used (kWh)' }, { field: 'grid_export_kwh', label: 'Grid exported (kWh)' }];
function getColumns(c) { try { const cfg = JSON.parse(c.dataset.tableConfig || '{}'); return cfg.columns || DEFAULT_COLUMNS; } catch (e) { return DEFAULT_COLUMNS; } }
const kwh = v => `${(Number(v) || 0).toFixed(1)} kWh`;
const partKwh = n => `${n >= 100 ? Math.round(n) : n.toFixed(1)} kWh`;

/** Fill one table body. rows: newest first; label(row) gives the first cell. */
function fill(container, tbody, rows, label) {
  const cols = getColumns(container);
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="${1 + cols.length}" class="energy-table-empty">No data yet</td></tr>`; return; }
  tbody.innerHTML = rows.map(row => `<tr><th scope="row">${escapeHtml(label(row))}</th>${cols.map(col => `<td data-field="${escapeHtml(col.field)}">${kwh(row[col.field])}</td>`).join('')}</tr>`).join('');
  const mode = container.dataset.breakdown || 'off', depth = container.dataset.breakdownDepth || 'one';
  if (mode === 'off') return;
  const trs = tbody.querySelectorAll('tr');
  rows.forEach((row, i) => {
    if (!row.parts) return;
    cols.forEach(col => {
      const parts = row.parts[col.field]; if (!parts) return;
      const td = trs[i].querySelector(`td[data-field="${CSS.escape(col.field)}"]`);
      const rows = treeRows(parts, depth, partKwh);
      // The month's total covers every day, its parts only from this day on.
      const since = row.partsSince && row.partsSince[col.field];
      if (since) rows.push({ label: 'Counted since', value: new Date(since + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) });
      renderBreakdown(td, rows, mode, `${col.label.replace(/\s*\(kWh\)$/, '')}, ${label(row)}`);
    });
  });
}

async function update(kind) {
  const containers = [...document.querySelectorAll(`.daily-breakdown-container[data-kind="${kind}"]`)];
  if (!containers.length) return;
  const res = await fetch(kind === 'daily' ? '/api/daily?days=30' : '/api/monthly');
  if (!res.ok) return;
  const data = await res.json();
  // Newest first. A copy: several tables share one response.
  const rows = Array.isArray(data) ? data.slice().reverse() : [];
  const label = kind === 'daily'
    ? row => new Date(row.day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : row => row.display || row.month || '—';
  for (const c of containers) {
    const tbody = c.querySelector('tbody');
    if (tbody) fill(c, tbody, rows, label);
  }
}

// Today's row keeps growing: refresh while a table is on the page (one timer
// however often the dashboard re-renders; it does nothing without tables).
const REFRESH_MS = 5 * 60 * 1000;
let timer = null;
function keepFresh() {
  if (timer || typeof setInterval !== 'function') return;
  timer = setInterval(() => { update('daily').catch(() => {}); update('monthly').catch(() => {}); }, REFRESH_MS);
}

export const updateDailyTable = () => { keepFresh(); return update('daily'); };
export const updateMonthlyTable = () => { keepFresh(); return update('monthly'); };
