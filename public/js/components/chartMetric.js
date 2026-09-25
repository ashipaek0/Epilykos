import { uid } from '../utils/uid.js';
import { escapeHtml } from '../utils.js';


/** Best-effort unit hint for a metric name, used as a default when a dataset omits `unit`. */
function metricUnitHint(metric) {
  if (!metric) return '';
  const m = String(metric).toLowerCase();
  if (/(temp)/.test(m)) return '°C';
  if (/(soc|percent|%)/.test(m)) return '%';
  if (/(kwh|energy|daily|daily_kwh)/.test(m)) return 'kWh';
  if (/(kw|power|consumption|load|solar|grid|import|export|battery|watt)/.test(m)) return 'kW';
  return '';
}

function normalizeDatasets(datasets) {
  // Read CSS variable colors for dark/light mode adaptation
  var style = getComputedStyle(document.documentElement);
  var cLoad = style.getPropertyValue('--color-home').trim();
  var cSolar = style.getPropertyValue('--color-solar').trim();
  var cBatt = style.getPropertyValue('--color-battery').trim();
  var cGrid = style.getPropertyValue('--color-grid').trim();
  var cExport = style.getPropertyValue('--color-export').trim();
  var cFallback = style.getPropertyValue('--text-secondary').trim();
  if (!datasets || !datasets.length) return [{ label: 'Consumption', metric: 'consumption_kw', color: cLoad, unit: 'kW', scale: 1 }];
  return datasets.map(ds => {
    const raw = (typeof ds === 'string') ? { metric: ds } : (ds || {});
    const metric = raw.metric || '';
    const unit = raw.unit != null ? raw.unit : metricUnitHint(metric);
    const scale = parseFloat(raw.scale != null ? raw.scale : 1);
    return { label: raw.label || raw.metric || 'Unknown', metric: metric, color: raw.color || cFallback, unit: unit, scale: isNaN(scale) ? 1 : scale };
  });
}

export function buildChartMetric(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const datasets = normalizeDatasets(config.datasets);
  if (!block.config) block.config = {};
  block.config.datasets = datasets;
  const container = document.createElement('div');
  container.className = 'chart-container'; container.dataset.chartDatasets = JSON.stringify(datasets); container.dataset.chartConfig = JSON.stringify(config || {}); container.dataset.blockId = id;
  container.innerHTML = `<div class="chart-header"><h3>${escapeHtml(config.title || 'Metric Chart')}</h3><div class="chart-controls" id="${uid('metric-chart-controls', id)}"><button data-range="24h" class="active">24h</button><button data-range="3d">3d</button><button data-range="7d">7d</button></div></div><div class="chart-loading" id="${uid('metricChart-loading', id)}">Loading chart\u2026</div><canvas id="${uid('metricChart', id)}" style="display:none;"></canvas>`;
  container.querySelector('#' + uid('metric-chart-controls', id)).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const r = b.dataset.range; if (r) { container.querySelectorAll('button').forEach(x => x.classList.remove('active')); b.classList.add('active'); import('../charts.js').then(m => m.setMetricRange(r)); } });
  return container;
}
