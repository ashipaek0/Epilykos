import { uid } from '../utils/uid.js';
import { escapeHtml } from '../utils.js';


function normalizeDatasets(datasets) {
  if (!datasets || !datasets.length) return [{ label: 'Solar Generated', metric: 'daily_solar', color: '#f59e0b' }, { label: 'Grid Imported', metric: 'daily_grid_import', color: '#87aec8' }, { label: 'Energy Consumed', metric: 'daily_consumption', color: '#44403c' }];
  if (typeof datasets[0] === 'string') { const lm = { solar: { label: 'Solar Generated', color: '#f59e0b' }, grid_import: { label: 'Grid Imported', color: '#87aec8' }, consumption: { label: 'Energy Consumed', color: '#44403c' }, battery_charge: { label: 'Battery Charge', color: '#84a45a' }, battery_discharge: { label: 'Battery Discharge', color: '#84a45a' }, grid_export: { label: 'Grid Export', color: '#d97706' } }; return datasets.map(ds => { const b = lm[ds] || { label: ds, color: '#888' }; return { label: b.label, metric: ds, color: b.color }; }); }
  return datasets.map(ds => ({ label: ds.label || ds.metric || 'Unknown', metric: ds.metric || '', color: ds.color || '#888' }));
}

export function buildChartEnergy(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const datasets = normalizeDatasets(config.datasets);
  if (!block.config) block.config = {};
  block.config.datasets = datasets;
  const container = document.createElement('div');
  container.className = 'chart-container'; container.dataset.chartDatasets = JSON.stringify(datasets); container.dataset.blockId = id;
  container.innerHTML = `<div class="chart-header"><h3>${escapeHtml(config.title||'Daily Energy')}</h3><div class="chart-controls" id="${uid('energy-chart-controls',id)}"><button data-range="7d" class="active">7d</button><button data-range="30d">30d</button><button data-range="90d">90d</button></div></div><div class="chart-loading" id="${uid('energyBarChart-loading',id)}">Loading chart\u2026</div><canvas id="${uid('energyBarChart',id)}" style="display:none;"></canvas>`;
  container.querySelector('#'+uid('energy-chart-controls',id)).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const r = b.dataset.range; if (r) { container.querySelectorAll('button').forEach(x => x.classList.remove('active')); b.classList.add('active'); import('../charts.js').then(m => m.setEnergyRange(r)); } });
  return container;
}