/**
 * Chart Management
 *
 * Chart.js wrapper for the power (line), energy (bar) and metric (line)
 * charts. Each chart belongs to its own canvas element: it keeps its own
 * range and series, and is destroyed once its canvas leaves the page (a block
 * re-rendered in the editor, a dashboard switch), so a new canvas always gets
 * a fresh chart.
 *
 * Power chart: 24h/3d range, configurable datasets, solar/grid zone shading.
 * Energy chart: 7d/30d/90d range, configurable datasets.
 * Metric chart: 24h/3d/7d of any metrics from /api/metrics/history.
 *
 * @module charts
 */
import { fetchDashboardState } from './api.js';
import { destroyPvTodayCharts } from './components/pvToday.js';
import { chartJSReady } from './chartLoader.js';

/** canvas element → { chart, kind } */
const instances = new Map();
const KINDS = { power: 'powerChart', energy: 'energyBarChart', metric: 'metricChart' };
const DEFAULT_RANGE = { power: '24h', energy: '7d', metric: '24h' };

/** Resolve any arbitrary metric name to the matching API power field via keyword matching. */
function resolvePowerField(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/solar|pv/.test(n)) return 'solar_kw';
  if (/consumption|load/.test(n)) return 'consumption_kw';
  if (/battery/.test(n)) {
    if (/discharge|discharging/.test(n)) return 'battery_discharge_kw';
    if (/charge|charging/.test(n)) return 'battery_charge_kw';
    return 'battery_power_kw';
  }
  if (/grid/.test(n)) {
    if (/export/.test(n)) return 'grid_export_kw';
    return 'grid_import_kw';
  }
  console.warn('[charts] could not resolve power field for metric:', metricName);
  return null;
}

/** Resolve any arbitrary metric name to the matching API energy field via keyword matching. */
function resolveEnergyField(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/solar|pv/.test(n)) return 'solar_kwh';
  if (/consumption|load/.test(n)) return 'consumption_kwh';
  if (/battery/.test(n)) {
    if (/discharge|discharging/.test(n)) return 'battery_discharge_kwh';
    return 'battery_charge_kwh';
  }
  if (/grid/.test(n)) {
    if (/export/.test(n)) return 'grid_export_kwh';
    return 'grid_import_kwh';
  }
  console.warn('[charts] could not resolve energy field for metric:', metricName);
  return null;
}

/** Resolve any arbitrary metric name to the API metric field via exact pass-through (no keyword mapping). */
function resolveMetricField(metricName) {
  return (metricName || '').trim() || null;
}

function getDatasets(c) { if (c && c.dataset.chartDatasets) { try { return JSON.parse(c.dataset.chartDatasets); } catch (e) {} } return null; }
function defaultPower() { return [{ label: 'Load', metric: 'consumption', color: '#44403c' }, { label: 'Solar', metric: 'solar', color: '#f59e0b' }, { label: 'Battery Power', metric: 'battery_power', color: '#84a45a' }, { label: 'Grid Import', metric: 'grid_import', color: '#87aec8' }]; }
function defaultEnergy() { return [{ label: 'Solar Generated', metric: 'daily_solar', color: '#f59e0b' }, { label: 'Grid Imported', metric: 'daily_grid_import', color: '#87aec8' }, { label: 'Energy Consumed', metric: 'daily_consumption', color: '#44403c' }]; }

/** Read chart config from the container's data attribute. */
function getChartConfig(container) {
  if (!container) return {};
  try { return JSON.parse(container.dataset.chartConfig || '{}'); } catch (e) { return {}; }
}
function rangeOf(container, kind) { return (container && container.dataset.range) || DEFAULT_RANGE[kind]; }

/** Grid and text colours from the page's theme tokens. */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const grid = cs.getPropertyValue('--border').trim() || (isDark ? '#2a2a2a' : '#d4d2cc');
  const text = cs.getPropertyValue('--text-secondary').trim() || (isDark ? '#999999' : '#555555');
  return { grid, text };
}

const zonePlugin = { id: 'zonePlugin', beforeDraw(chart) { const { ctx, chartArea, scales } = chart; if (!chartArea) return; const zy = scales.y.getPixelForValue(0); if (zy > chartArea.top) { const g = ctx.createLinearGradient(0, chartArea.top, 0, zy); g.addColorStop(0, 'rgba(245,158,11,0.12)'); g.addColorStop(0.6, 'rgba(245,158,11,0.04)'); g.addColorStop(1, 'rgba(245,158,11,0)'); ctx.fillStyle = g; ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, zy - chartArea.top); } if (zy < chartArea.bottom) { const g = ctx.createLinearGradient(0, zy, 0, chartArea.bottom); g.addColorStop(0, 'rgba(135,174,200,0)'); g.addColorStop(0.4, 'rgba(135,174,200,0.08)'); g.addColorStop(1, 'rgba(135,174,200,0.18)'); ctx.fillStyle = g; ctx.fillRect(chartArea.left, zy, chartArea.right - chartArea.left, chartArea.bottom - zy); } } };

/** Destroy charts whose canvas is no longer in the page. */
function sweep() {
  for (const [canvas, inst] of instances) {
    if (!canvas.isConnected) { inst.chart.destroy(); instances.delete(canvas); }
  }
}
function chartsOf(kind) {
  sweep();
  return [...instances].filter(([, inst]) => inst.kind === kind).map(([canvas, inst]) => ({ canvas, chart: inst.chart, container: canvas.closest('.chart-container') }));
}

export function destroyCharts() {
  for (const inst of instances.values()) inst.chart.destroy();
  instances.clear();
  destroyPvTodayCharts();
}

function lineOptions(cfg, yTitle) {
  const { grid, text } = themeColors();
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    elements: { line: { borderWidth: 2, tension: 0.35 }, point: { radius: 0, hoverRadius: 4 } },
    scales: {
      x: { type: 'time', time: { unit: 'hour' }, grid: { color: grid, display: !cfg.hideGrid }, ticks: { color: text, maxRotation: 0, autoSkipPadding: 12 } },
      y: { title: { display: true, text: yTitle, color: text }, grid: { color: grid, display: !cfg.hideGrid }, ticks: { color: text }, grace: '5%' }
    },
    plugins: { tooltip: { mode: 'index', intersect: false }, legend: { labels: { color: text, boxWidth: 12, boxHeight: 12, usePointStyle: true } } }
  };
}

/** Create charts for this kind's canvases that don't have one yet. */
function initKind(kind) {
  sweep();
  // Chart.js alone isn't enough: time axes need the date adapter too.
  if (typeof Chart === 'undefined' || !chartJSReady()) return [];
  const created = [];
  document.querySelectorAll(`.chart-container canvas[id^="${KINDS[kind]}"]`).forEach(canvas => {
    if (instances.has(canvas)) return;
    const container = canvas.closest('.chart-container');
    const cfg = getChartConfig(container);
    container?.querySelector('.chart-loading')?.remove();
    canvas.style.display = '';
    let chart;
    if (kind === 'energy') {
      const { grid, text } = themeColors();
      const ds = getDatasets(container) || defaultEnergy();
      chart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: [], datasets: ds.map(d => ({ label: d.label, backgroundColor: d.color || '#888', data: [], borderRadius: 4, maxBarThickness: 28 })) },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
          scales: { x: { grid: { color: grid, display: !cfg.hideGrid }, ticks: { color: text, maxRotation: 0, autoSkipPadding: 8 } }, y: { title: { display: true, text: 'Energy (kWh)', color: text }, grid: { color: grid, display: !cfg.hideGrid }, ticks: { color: text }, beginAtZero: true } },
          plugins: { legend: { labels: { color: text, boxWidth: 12, boxHeight: 12, usePointStyle: true } }, tooltip: { mode: 'index', intersect: false } } }
      });
    } else if (kind === 'power') {
      chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: [] }, options: lineOptions(cfg, 'Power (kW)'), plugins: cfg.hideGrid ? [] : [zonePlugin] });
    } else {
      const ds = getDatasets(container) || [];
      const yTitle = (ds[0] && ds[0].unit) ? ds[0].unit : (cfg.yAxis?.unit || 'Value');
      chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: [] }, options: lineOptions(cfg, yTitle), plugins: cfg.hideGrid ? [] : [zonePlugin] });
    }
    instances.set(canvas, { chart, kind });
    created.push({ canvas, chart, container });
  });
  return created;
}

export function initPowerChart() { return initKind('power'); }
export function initEnergyChart() { return initKind('energy'); }
export function initMetricChart() { return initKind('metric'); }

function resolveColor(color) { if (!color) return '#ccc'; if (color.startsWith('#')) return color; return '#ccc'; }

export function applyGradientFills(chart) { if (!chart || !chart.ctx) return; requestAnimationFrame(() => { const ctx = chart.ctx, ca = chart.chartArea; if (!ca) { setTimeout(() => applyGradientFills(chart), 50); return; } chart.data.datasets.forEach((ds, i) => { if (!chart.getDatasetMeta(i).hidden && ds.data.length) { const g = ctx.createLinearGradient(0, ca.bottom, 0, ca.top), hx = resolveColor(ds.borderColor || '#ccc'), r = parseInt(hx.slice(1, 3), 16), gv = parseInt(hx.slice(3, 5), 16), b = parseInt(hx.slice(5, 7), 16); g.addColorStop(0, `rgba(${r},${gv},${b},0.03)`); g.addColorStop(0.5, `rgba(${r},${gv},${b},0.08)`); g.addColorStop(1, `rgba(${r},${gv},${b},0.16)`); ds.backgroundColor = g; } }); chart.update(); }); }

export function updateChartColors() {
  sweep();
  const { grid, text } = themeColors();
  for (const [canvas, { chart, kind }] of instances) {
    const cfg = getChartConfig(canvas.closest('.chart-container'));
    chart.options.scales.x.grid.color = grid; chart.options.scales.y.grid.color = grid;
    chart.options.scales.x.ticks.color = text; chart.options.scales.y.ticks.color = text;
    chart.options.scales.y.title.color = text;
    chart.options.plugins.legend.labels.color = text;
    chart.update();
    if (kind !== 'energy' && cfg.fill !== false) applyGradientFills(chart);
  }
}

// ── Power ─────────────────────────────────────────────────────────────────

async function powerHistoryFor(range) {
  if (range === '3d') {
    const r = await fetch('/api/history?days=3');
    const hd = await r.json();
    return hd.map(d => ({ timestamp: d.timestamp, consumption_kw: d.consumption_kw ?? 0, solar_kw: d.solar_kw ?? 0, battery_charge_kw: d.battery_charge_kw ?? 0, battery_discharge_kw: d.battery_discharge_kw ?? 0, battery_power_kw: d.battery_power_kw ?? 0, grid_import_kw: d.grid_import_kw ?? 0, grid_export_kw: d.grid_export_kw ?? 0 }));
  }
  const s = await fetchDashboardState();
  return s.powerHistory;
}

function updatePowerChartData(chart, container, data) {
  if (!data || !data.length) return;
  const cfg = getChartConfig(container);
  const ds = getDatasets(container) || defaultPower();
  const existing = chart.data.datasets;
  ds.forEach((d, i) => {
    const f = resolvePowerField(d.metric);
    const pts = data.map(p => ({ x: p.timestamp, y: f ? (p[f] ?? 0) : 0 }));
    if (i < existing.length) { existing[i].label = d.label; existing[i].data = pts; existing[i].borderColor = resolveColor(d.color); existing[i].fill = cfg.fill !== false; }
    else existing.push({ label: d.label, data: pts, borderColor: resolveColor(d.color), fill: cfg.fill !== false, tension: 0.35, borderWidth: 2 });
  });
  while (existing.length > ds.length) existing.pop();
  chart.options.scales.x.time.unit = rangeOf(container, 'power') === '3d' ? 'day' : 'hour';
  chart.update();
  if (cfg.fill !== false) applyGradientFills(chart);
}

async function refreshPowerChartFor({ chart, container }) {
  try { updatePowerChartData(chart, container, await powerHistoryFor(rangeOf(container, 'power'))); }
  catch (e) { console.warn('[charts] power refresh failed:', e); }
}

export async function refreshPowerChart() { for (const c of chartsOf('power')) await refreshPowerChartFor(c); }

/** Change one power chart's range (and optionally its series). */
export function setPowerRange(range, datasets, container) {
  const targets = chartsOf('power').filter(c => !container || c.container === container);
  targets.forEach(c => {
    c.container.dataset.range = range;
    if (datasets) c.container.dataset.chartDatasets = JSON.stringify(datasets);
    refreshPowerChartFor(c);
  });
}

export function updatePowerChartFromState(state) {
  if (!state) return;
  initKind('power');
  for (const c of chartsOf('power')) {
    if (rangeOf(c.container, 'power') !== '24h') { refreshPowerChartFor(c); continue; }
    updatePowerChartData(c.chart, c.container, state.powerHistory);
  }
}

// ── Energy ────────────────────────────────────────────────────────────────

function updateEnergyChartData(chart, container, data) {
  if (!data || !data.length) return;
  const src = getDatasets(container) || defaultEnergy();
  chart.data.labels = data.map(d => new Date(d.day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  const existing = chart.data.datasets;
  src.forEach((s, i) => {
    const f = resolveEnergyField(s.metric);
    const vals = f ? data.map(d => d[f] || 0) : [];
    if (i < existing.length) { existing[i].label = s.label; existing[i].data = vals; existing[i].backgroundColor = s.color || '#888'; }
    else existing.push({ label: s.label, data: vals, backgroundColor: s.color || '#888', borderRadius: 4, maxBarThickness: 28 });
  });
  while (existing.length > src.length) existing.pop();
  chart.update();
}

async function refreshEnergyChartFor({ chart, container }) {
  try {
    const days = parseInt(rangeOf(container, 'energy'), 10) || 7;
    const r = await fetch(`/api/daily?days=${days}`);
    updateEnergyChartData(chart, container, await r.json());
  } catch (e) { console.warn('[charts] energy refresh failed:', e); }
}

export async function refreshEnergyChart() { for (const c of chartsOf('energy')) await refreshEnergyChartFor(c); }

/** Change one energy chart's range (all of them when no container is given). */
export function setEnergyRange(range, container) {
  chartsOf('energy').filter(c => !container || c.container === container).forEach(c => {
    c.container.dataset.range = range;
    refreshEnergyChartFor(c);
  });
}

export function updateEnergyChartFromState(state) {
  if (!state) return;
  initKind('energy');
  for (const c of chartsOf('energy')) {
    if (rangeOf(c.container, 'energy') !== '7d') { refreshEnergyChartFor(c); continue; }
    if (state.dailyEnergyBar) updateEnergyChartData(c.chart, c.container, state.dailyEnergyBar);
  }
}

// ── Metric ────────────────────────────────────────────────────────────────

function setMetricEmptyState(ct, isEmpty) {
  if (!ct) return;
  let emptyEl = ct.querySelector('.chart-empty');
  if (isEmpty) {
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'chart-empty';
      emptyEl.textContent = 'No data available for the selected range';
      ct.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
  }
}

function updateMetricChartData(chart, container, data, dsIndex) {
  const cfg = getChartConfig(container);
  const src = getDatasets(container) || [];
  const d = src[dsIndex] || {};
  const existing = chart.data.datasets;
  const pts = Array.isArray(data) ? data : [];
  if (dsIndex < existing.length) {
    existing[dsIndex].label = d.label || 'Metric';
    existing[dsIndex].data = pts;
    existing[dsIndex].borderColor = resolveColor(d.color);
    existing[dsIndex].fill = cfg.fill !== false;
  } else {
    existing.push({ label: d.label || 'Metric', data: pts, borderColor: resolveColor(d.color), fill: cfg.fill !== false, tension: 0.35, borderWidth: 2 });
  }
  while (existing.length > src.length) existing.pop();
  chart.options.scales.x.time.unit = rangeOf(container, 'metric') === '24h' ? 'hour' : 'day';
  chart.update();
  if (cfg.fill !== false && pts.length) applyGradientFills(chart);
}

async function refreshMetricChartFor({ chart, container }) {
  const ds = getDatasets(container) || [];
  const range = rangeOf(container, 'metric');
  const hours = range === '3d' ? 72 : (range === '7d' ? 168 : 24);
  const results = await Promise.all(ds.map(async (d, i) => {
    let points = [];
    if (d.metric && resolveMetricField(d.metric)) {
      try {
        const r = await fetch(`/api/metrics/history?metric=${encodeURIComponent(d.metric)}&hours=${hours}`);
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr)) points = arr.map(p => ({ x: p.timestamp, y: (p.value ?? 0) * (parseFloat(d.scale || 1) || 1) }));
        }
      } catch (e) { points = []; }
    }
    updateMetricChartData(chart, container, points, i);
    return points.length > 0;
  }));
  setMetricEmptyState(container, !results.some(Boolean));
}

export async function refreshMetricChart() { for (const c of chartsOf('metric')) await refreshMetricChartFor(c); }

/** Change one metric chart's range (and optionally its series). */
export function setMetricRange(range, datasets, container) {
  chartsOf('metric').filter(c => !container || c.container === container).forEach(c => {
    c.container.dataset.range = range;
    if (datasets) c.container.dataset.chartDatasets = JSON.stringify(datasets);
    refreshMetricChartFor(c);
  });
}

// Metric history changes slowly; a push every few seconds needn't refetch it.
const METRIC_REFRESH_MS = 60000;
const lastMetricRefresh = new WeakMap();
export function updateMetricChartFromState(state) {
  if (!state) return;
  const fresh = initKind('metric').map(c => c.canvas);
  for (const c of chartsOf('metric')) {
    const last = lastMetricRefresh.get(c.canvas) || 0;
    if (fresh.includes(c.canvas) || Date.now() - last > METRIC_REFRESH_MS) {
      lastMetricRefresh.set(c.canvas, Date.now());
      refreshMetricChartFor(c);
    }
  }
}
