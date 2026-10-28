import { uid } from '../utils/uid.js';
import { escapeHtml } from '../utils.js';


function normalizeDatasets(datasets) {
  // Read CSS variable colors for dark/light mode adaptation
  var style = getComputedStyle(document.documentElement);
  var cSolar = style.getPropertyValue('--color-solar').trim();
  var cGrid = style.getPropertyValue('--color-grid').trim();
  var cLoad = style.getPropertyValue('--color-home').trim();
  var cBatt = style.getPropertyValue('--color-battery').trim();
  var cExport = style.getPropertyValue('--color-export').trim();
  var cFallback = style.getPropertyValue('--text-secondary').trim();
  if (!datasets || !datasets.length) return [{ label: 'Solar Generated', metric: 'daily_solar', color: cSolar }, { label: 'Grid Imported', metric: 'daily_grid_import', color: cGrid }, { label: 'Energy Consumed', metric: 'daily_consumption', color: cLoad }];
  if (typeof datasets[0] === 'string') { const lm = { solar: { label: 'Solar Generated', color: cSolar }, grid_import: { label: 'Grid Imported', color: cGrid }, consumption: { label: 'Energy Consumed', color: cLoad }, battery_charge: { label: 'Battery Charge', color: cBatt }, battery_discharge: { label: 'Battery Discharge', color: cBatt }, grid_export: { label: 'Grid Export', color: cExport } }; return datasets.map(ds => { const b = lm[ds] || { label: ds, color: cFallback }; return { label: b.label, metric: ds, color: b.color }; }); }
  return datasets.map(ds => ({ label: ds.label || ds.metric || 'Unknown', metric: ds.metric || '', color: ds.color || cFallback }));
}

export function buildChartEnergy(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const datasets = normalizeDatasets(config.datasets);
  if (!block.config) block.config = {};
  block.config.datasets = datasets;
  const container = document.createElement('div');
  container.className = 'chart-container'; container.dataset.chartDatasets = JSON.stringify(datasets); container.dataset.chartConfig = JSON.stringify(config || {}); container.dataset.blockId = id;
  container.innerHTML = `<div class="chart-header"><h3>${escapeHtml(config.title||'Daily Energy')}</h3><div class="chart-controls" id="${uid('energy-chart-controls',id)}"><span class="chart-compare" hidden><select class="chart-compare-mode" aria-label="Compare"><option value="year">Year on year</option><option value="month">Month on month</option><option value="total">Yearly totals</option></select><select class="chart-compare-metric" aria-label="Metric to compare"></select></span><button data-range="7d">7d</button><button data-range="30d" class="active">30d</button><button data-range="90d">90d</button><button data-range="6m">6m</button><button data-range="1y">1y</button><button data-range="compare">Compare</button></div></div><div class="chart-loading" id="${uid('energyBarChart-loading',id)}">Loading chart\u2026</div><canvas id="${uid('energyBarChart',id)}" style="display:none;"></canvas>`;
  container.querySelector('#'+uid('energy-chart-controls',id)).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const r = b.dataset.range; if (r) { container.querySelectorAll('button').forEach(x => x.classList.remove('active')); b.classList.add('active'); import('../charts.js').then(m => m.setEnergyRange(r, container)); } });
  container.querySelector('.chart-compare').addEventListener('change', e => {
    const select = e.target.closest('select'); if (!select) return;
    import('../charts.js').then(m => m.setEnergyCompare(select.classList.contains('chart-compare-mode') ? { mode: select.value } : { metric: select.value }, container));
  });
  return container;
}