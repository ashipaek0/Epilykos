import { uid } from '../utils/uid.js';
import { escapeHtml } from '../utils.js';


export function buildDataTableDaily(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const columns = config.columns || [{ field: 'consumption_kwh', label: 'Load (kWh)' }, { field: 'solar_kwh', label: 'Solar PV (kWh)' }, { field: 'battery_charge_kwh', label: 'Battery charged (kWh)' }, { field: 'battery_discharge_kwh', label: 'Battery discharged (kWh)' }, { field: 'grid_import_kwh', label: 'Grid used (kWh)' }, { field: 'grid_export_kwh', label: 'Grid exported (kWh)' }];
  const container = document.createElement('div');
  container.className = 'daily-breakdown-container'; container.style.marginBottom = '1rem';
  container.dataset.tableConfig = JSON.stringify({ columns }); container.dataset.blockId = id;
  const thHtml = columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
  container.innerHTML = `<div class="daily-breakdown-header"><h3>${escapeHtml(config.title||'Last 30 Days')}</h3><button class="toggle-btn">▼</button></div><div class="daily-breakdown-content"><div class="daily-table-wrapper"><table class="energy-table"><thead><tr><th>Date</th>${thHtml}</tr></thead><tbody id="${uid('daily-table-body',id)}"></tbody></table></div></div>`;
  container.querySelector('.toggle-btn').addEventListener('click', function(){ const c = this.closest('.daily-breakdown-container').querySelector('.daily-breakdown-content'); const coll = c.classList.toggle('collapsed'); this.textContent = coll ? '▲' : '▼'; });
  return container;
}