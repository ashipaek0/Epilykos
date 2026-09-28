import { uid } from '../utils/uid.js';
import { ensureChartJS } from '../chartLoader.js';
import { normalizeSeries, reduceAndAlign, buildTimeseriesChartModel, calculateCoverage, calculateLegend, calculateAxisBounds, thresholdPlugin } from '../multiSeriesTimeseries.mjs';

const charts = new WeakMap();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function setLegendPlacement(legend, position) {
  const placement = position === 'right' ? 'right' : 'bottom';
  legend.className = `timeseries-legend mst-legend mst-legend--${placement}`;
  legend.dataset.timeseriesLegend = placement;
}

export function buildMultiSeriesTimeseries(block = {}) {
  const cfg = block.config || {};
  const container = element('div', 'chart-container multi-series-timeseries');
  container.dataset.blockId = block.id || '';
  container.dataset.chartConfig = JSON.stringify(cfg);
  container.dataset.qaFamily = 'multi-series-timeseries';
  normalizeSeries(cfg.series || [], {reducer:cfg.reducer});
  const header = element('div', 'chart-header');
  header.append(element('h3', '', cfg.title || 'Multi-series time series'));
  const controls = element('div', 'chart-controls');
  const range = element('button', 'active', cfg.range || '24h');
  range.dataset.range = cfg.range || '24h';
  controls.append(range);
  header.append(controls);
  container.append(header);
  const status = element('div', 'chart-status');
  status.dataset.chartStatus = '';
  status.setAttribute('role', 'status');
  container.append(status);
  const body = element('div', 'mst-chart-body');
  const plot = element('div', 'mst-chart-plot');
  const canvas = element('canvas');
  canvas.id = uid('multiSeriesChart', block.id || 'chart');
  canvas.dataset.multiSeriesChart = '';
  plot.append(canvas);
  const legend = element('div', 'timeseries-legend mst-legend');
  setLegendPlacement(legend, cfg.legend?.position);
  body.append(plot, legend);
  container.append(body);
  const thresholds = element('div', 'timeseries-thresholds');
  thresholds.dataset.timeseriesThresholds = '';
  container.append(thresholds);
  return container;
}

function renderLegend(target, series, aligned, config) {
  target.replaceChildren();
  const table = element('table', 'timeseries-legend-table');
  const head = element('tr');
  head.append(element('th', '', 'Series'));
  for (const key of config.legend?.calculations || []) head.append(element('th', '', key));
  table.append(head);
  series.forEach((item, index) => {
    const row = element('tr');
    row.append(element('th', '', item.label));
    const values = calculateLegend(aligned[index], config.legend?.calculations || []);
    for (const key of config.legend?.calculations || []) {
      const value = values[key];
      const shown = value === null ? '—' : Number(value).toFixed(item.decimals);
      row.append(element('td', '', value === null ? shown : `${shown}${item.unit ? ` ${item.unit}` : ''}`));
    }
    table.append(row);
  });
  target.append(table);
}

export async function updateMultiSeriesTimeseries() {
  let chartLoadError = null;
  try {
    await ensureChartJS();
  } catch (error) {
    chartLoadError = error;
  }
  for (const container of document.querySelectorAll('.multi-series-timeseries')) {
    const config = JSON.parse(container.dataset.chartConfig || '{}');
    const series = normalizeSeries(config.series || [], {reducer:config.reducer});
    const hours = Number(config.hours || 24);
    const windowMs = Number(config.windowMs || 60000);
    const end = Date.now();
    const start = end - hours * 3600000;
    const results = await Promise.all(series.map(async item => {
      if (!item.binding.metric) return { points: [], error: 'Metric not configured' };
      try {
        const response = await fetch(`/api/metrics/history?metric=${encodeURIComponent(item.binding.metric)}&hours=${hours}`);
        if (!response.ok) throw new Error('History request failed');
        return { points: await response.json() };
      } catch (error) {
        return { points: [], error: error.message || 'History unavailable' };
      }
    }));
    const aligned = results.map((result, index) => reduceAndAlign(result.points || [], { start, end, windowMs, reducer: series[index].reducer }));
    const model = buildTimeseriesChartModel(config);
    model.datasets.forEach((dataset, index) => {
      dataset.data = aligned[index].map(point => ({ x: point.x, y: point.y === null ? null : point.y * series[index].scale }));
    });
    const coverage = aligned.map(points => calculateCoverage(start, end, points, windowMs));
    const noData = aligned.every(points => points.every(point => point.y === null));
    const partial = results.some(result => result.error) || coverage.some(item => item.status !== 'complete');
    const statusNode = container.querySelector('[data-chart-status]');
    if (statusNode) {
      statusNode.dataset.status = noData ? 'no-data' : partial ? 'partial' : 'complete';
      statusNode.textContent = noData ? 'No data available for the requested range' : partial ? 'Partial coverage; some series or requested times have no data' : 'Full requested coverage';
      if (chartLoadError) {
        statusNode.dataset.status = 'error';
        statusNode.textContent = 'Chart unavailable; no chart could be rendered';
      }
    }
    const scaled = aligned.map((points, index) => points.map(point => ({ ...point, y: point.y === null ? null : point.y * series[index].scale })));
    const legend = container.querySelector('[data-timeseries-legend]');
    if (legend) {
      setLegendPlacement(legend, config.legend?.position);
      renderLegend(legend, series, scaled, config);
    }
    const thresholdTarget = container.querySelector('[data-timeseries-thresholds]');
    if (thresholdTarget) {
      thresholdTarget.replaceChildren();
      const thresholds = Array.isArray(config.thresholds) ? config.thresholds : [];
      thresholdTarget.hidden = thresholds.length === 0;
      for (const threshold of thresholds) {
        const descriptor = element('div', 'mst-threshold-descriptor', `${threshold.label ? threshold.label + ': ' : ''}${Number(threshold.value)} · ${Array.isArray(threshold.dash) ? threshold.dash.join(', ') : '6, 4'}`);
        descriptor.style.borderLeft = `3px dashed ${threshold.color || '#ef4444'}`;
        thresholdTarget.append(descriptor);
      }
    }
    const axis = config.axis || {};
    const yScale = { ...model.scales.y, ...calculateAxisBounds(axis, model.datasets) };
    const canvas = container.querySelector('[data-multi-series-chart]');
    if (!canvas || chartLoadError || typeof Chart === 'undefined') continue;
    const options = { responsive: true, maintainAspectRatio: false, parsing: false, interaction: { mode: 'index', intersect: false }, scales: { ...model.scales, x: { type: 'time' }, y: yScale }, plugins: { ...model.plugins, legend: { ...model.plugins.legend, display: false } } };
    const plugin = thresholdPlugin(model.thresholds);
    let chart = charts.get(canvas);
    if (!chart) {
      chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: model.datasets }, options, plugins: [plugin] });
      charts.set(canvas, chart);
    } else {
      chart.data.datasets = model.datasets;
      chart.options.scales = options.scales;
      chart.options.plugins = options.plugins;
      chart.$multiSeriesThresholds = model.thresholds;
      chart.$multiSeriesCoverage = coverage;
      chart.update();
    }
    chart.$multiSeriesThresholds = model.thresholds;
    chart.$multiSeriesCoverage = coverage;
  }
}
