import { uid } from '../utils/uid.js';

function normalizeDatasets(datasets) {
  if (!datasets || !datasets.length) return [{ label: 'Load', metric: 'consumption', color: '#7c3aed' }, { label: 'Solar', metric: 'solar', color: '#d97706' }, { label: 'Battery Charge', metric: 'battery_charge', color: '#059669' }, { label: 'Grid Import', metric: 'grid_import', color: '#dc2626' }];
  if (typeof datasets[0] === 'string') { const lm = { load: { label: 'Load', color: '#7c3aed' }, solar: { label: 'Solar', color: '#d97706' }, battery_charge: { label: 'Battery Charge', color: '#059669' }, grid_import: { label: 'Grid Import', color: '#dc2626' }, battery_discharge: { label: 'Battery Discharge', color: '#10b981' }, grid_export: { label: 'Grid Export', color: '#f59e0b' } }; return datasets.map(ds => { const b = lm[ds] || { label: ds, color: '#888' }; return { label: b.label, metric: ds, color: b.color }; }); }
  return datasets.map(ds => ({ label: ds.label || ds.metric || 'Unknown', metric: ds.metric || '', color: ds.color || '#888' }));
}

export function buildChartPower(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const datasets = normalizeDatasets(config.datasets);
  if (!block.config) block.config = {};
  block.config.datasets = datasets;
  const container = document.createElement('div');
  container.className = 'chart-container'; container.dataset.chartDatasets = JSON.stringify(datasets); container.dataset.blockId = id;
  container.innerHTML = `<div class="chart-header"><h3>${escapeHtml(config.title||'Power Overview')}</h3><div class="chart-controls" id="${uid('power-chart-controls',id)}"><button data-range="24h" class="active">24h</button><button data-range="3d">3d</button></div></div><canvas id="${uid('powerChart',id)}"></canvas>`;
  container.querySelector('#'+uid('power-chart-controls',id)).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const r = b.dataset.range; if (r) { container.querySelectorAll('button').forEach(x => x.classList.remove('active')); b.classList.add('active'); import('../charts.js').then(m => m.setPowerRange(r, datasets)); } });
  return container;
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
