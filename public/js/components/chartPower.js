import { uid } from '../utils/uid.js';
import { escapeHtml } from '../utils.js';


function normalizeDatasets(datasets) {
  // Read CSS variable colors for dark/light mode adaptation
  var style = getComputedStyle(document.documentElement);
  var cLoad = style.getPropertyValue('--color-home').trim() || '#333333';
  var cSolar = style.getPropertyValue('--color-solar').trim() || '#f59e0b';
  var cBatt = style.getPropertyValue('--color-battery').trim() || '#4a6a2e';
  var cGrid = style.getPropertyValue('--color-grid').trim() || '#b33a2e';
  var cExport = style.getPropertyValue('--color-export').trim() || '#f59e0b';
  if (!datasets || !datasets.length) return [{ label: 'Load', metric: 'consumption', color: cLoad }, { label: 'Solar', metric: 'solar', color: cSolar }, { label: 'Battery Charge', metric: 'battery_charge', color: cBatt }, { label: 'Grid Import', metric: 'grid_import', color: cGrid }];
  if (typeof datasets[0] === 'string') { const lm = { load: { label: 'Load', color: cLoad }, solar: { label: 'Solar', color: cSolar }, battery_charge: { label: 'Battery Charge', color: cBatt }, grid_import: { label: 'Grid Import', color: cGrid }, battery_discharge: { label: 'Battery Discharge', color: cBatt }, grid_export: { label: 'Grid Export', color: cExport } }; return datasets.map(ds => { const b = lm[ds] || { label: ds, color: '#888' }; return { label: b.label, metric: ds, color: b.color }; }); }
  return datasets.map(ds => ({ label: ds.label || ds.metric || 'Unknown', metric: ds.metric || '', color: ds.color || '#888' }));
}

export function buildChartPower(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const datasets = normalizeDatasets(config.datasets);
  if (!block.config) block.config = {};
  block.config.datasets = datasets;
  const container = document.createElement('div');
  container.className = 'chart-container'; container.dataset.chartDatasets = JSON.stringify(datasets); container.dataset.chartConfig = JSON.stringify(config || {}); container.dataset.blockId = id;
  container.innerHTML = `<div class="chart-header"><h3>${escapeHtml(config.title||'Power Overview')}</h3><div class="chart-controls" id="${uid('power-chart-controls',id)}"><button data-range="24h" class="active">24h</button><button data-range="3d">3d</button></div></div><div class="chart-loading" id="${uid('powerChart-loading',id)}">Loading chart\u2026</div><canvas id="${uid('powerChart',id)}" style="display:none;"></canvas>`;
  container.querySelector('#'+uid('power-chart-controls',id)).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const r = b.dataset.range; if (r) { container.querySelectorAll('button').forEach(x => x.classList.remove('active')); b.classList.add('active'); import('../charts.js').then(m => m.setPowerRange(r, datasets)); } });
  return container;
}