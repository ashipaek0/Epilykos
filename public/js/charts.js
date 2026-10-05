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
import { normalizePowerStatsConfig, buildPowerStatsSection, updatePowerStatsSection, resolvePowerStatsField, createPowerStatsRequestGate } from './components/powerChartStats.js';

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
  const appearance = cfg.appearance || {};
  const valid = (v, fallback, min, max) => v !== '' && v != null && Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
  const min = valid(appearance.axisMin, undefined, -1e12, 1e12);
  const max = valid(appearance.axisMax, undefined, -1e12, 1e12);
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    elements: { line: { borderWidth: valid(appearance.lineWidth, 2, 0.5, 8), tension: 0.35 }, point: { radius: appearance.markers === true ? 2 : 0, hoverRadius: 4 } },
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
    const chartHeight = cfg.appearance?.height;
    const boundedHeight = chartHeight !== '' && chartHeight != null && Number.isFinite(Number(chartHeight))
      ? Math.min(1000, Math.max(120, Number(chartHeight))) : null;
    const canvasWrap = canvas.closest('.power-chart-canvas-wrap');
    if (kind === 'power' && boundedHeight !== null && canvasWrap) canvasWrap.style.height = `${boundedHeight}px`;
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
      const appearance = cfg.appearance || {}, axes = appearance.axes || {};
      const yUnit = appearance.axisUnit === 'W' ? 'W' : 'kW';
      const opts = lineOptions(cfg, `Power (${yUnit})`);
      // The right axis only shows when a series is plotted on it.
      const usesRight = (getDatasets(container) || defaultPower()).some(d => d && d.axis === 'right');
      for (const id of ['left', 'right']) {
        const axis = axes[id] || {};
        opts.scales[id === 'left' ? 'y' : 'yRight'] = { type: 'linear', position: id, display: id === 'left' || usesRight, title: { display: true, color: themeColors().text, text: `Power (${axis.unit === 'W' ? 'W' : yUnit})` }, grid: { color: themeColors().grid, display: !cfg.hideGrid && id === 'left' }, ticks: { color: themeColors().text } };
        if (axis.min !== '' && axis.min != null && Number.isFinite(Number(axis.min))) opts.scales[id === 'left' ? 'y' : 'yRight'].min = Number(axis.min);
        if (axis.max !== '' && axis.max != null && Number.isFinite(Number(axis.max))) opts.scales[id === 'left' ? 'y' : 'yRight'].max = Number(axis.max);
      }
      chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: [] }, options: opts, plugins: cfg.hideGrid ? [] : [zonePlugin] });
    } else {
      const ds = getDatasets(container) || [];
      const yTitle = (ds[0] && ds[0].unit) ? ds[0].unit : (cfg.yAxis?.unit || 'Value');
      chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: [] }, options: lineOptions(cfg, yTitle), plugins: cfg.hideGrid ? [] : [zonePlugin] });
    }
    instances.set(canvas, { chart, kind });
    created.push({ canvas, chart, container });
  });
  // A new chart fetches its own data. Waiting for the next live update left it
  // empty when Chart.js loaded after the first full update (updates in between
  // are deltas without history), or when no source sends updates at all.
  const refresh = { power: refreshPowerChartFor, energy: refreshEnergyChartFor, metric: refreshMetricChartFor }[kind];
  created.forEach(c => { if (refresh) refresh(c); });
  return created;
}

export function initPowerChart() { return initKind('power'); }
export function initEnergyChart() { return initKind('energy'); }
export function initMetricChart() { return initKind('metric'); }

function resolveColor(color) { if (!color) return '#ccc'; if (color.startsWith('#')) return color; return '#ccc'; }

export function applyGradientFills(chart) { if (!chart || !chart.ctx) return; requestAnimationFrame(() => { const ctx = chart.ctx, ca = chart.chartArea; if (!ca) { setTimeout(() => applyGradientFills(chart), 50); return; } chart.data.datasets.forEach((ds, i) => { if (!chart.getDatasetMeta(i).hidden && ds.data.length) { const g = ctx.createLinearGradient(0, ca.bottom, 0, ca.top), hx = resolveColor(ds.baseColor || ds.borderColor || '#ccc'), r = parseInt(hx.slice(1, 3), 16), gv = parseInt(hx.slice(3, 5), 16), b = parseInt(hx.slice(5, 7), 16); g.addColorStop(0, `rgba(${r},${gv},${b},0.03)`); g.addColorStop(0.5, `rgba(${r},${gv},${b},0.08)`); g.addColorStop(1, `rgba(${r},${gv},${b},0.16)`); ds.backgroundColor = g; } }); chart.update(); }); }

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

export function updatePowerChartData(chart, container, data) {
  const cfg = getChartConfig(container);
  const ds = getDatasets(container) || defaultPower();
  const appearance = cfg.appearance || {};
  const existing = chart.data.datasets;
  const axisConfigs = appearance.axes || {};
  ds.forEach((d, i) => {
    const f = resolvePowerField(d.metric);
    const axis = d.axis === 'right' ? 'right' : 'left', axisCfg = axisConfigs[axis] || {};
    const plotUnit = axisCfg.unit === 'W' || axisCfg.unit === 'kW' ? axisCfg.unit : (appearance.axisUnit === 'W' ? 'W' : 'kW');
    const unit = d.unit === 'W' || d.unit === 'kW' ? d.unit : plotUnit;
    const pts = data.map(p => ({ x: p.timestamp, y: f ? ((p[f] ?? 0) * (plotUnit === 'W' ? 1000 : 1)) : 0 }));
    const color = resolveColor(d.color), opacity = Number.isFinite(Number(d.opacity ?? appearance.opacity)) ? Math.min(1, Math.max(0, Number(d.opacity ?? appearance.opacity))) : 1;
    const lineWidth = Number.isFinite(Number(d.lineWidth ?? appearance.lineWidth)) && Number(d.lineWidth ?? appearance.lineWidth) > 0 ? Math.min(8, Math.max(0.5, Number(d.lineWidth ?? appearance.lineWidth))) : 2;
    const lineStyle = d.lineStyle || appearance.lineStyle;
    const style = { yAxisID: axis === 'right' ? 'yRight' : 'y', borderColor: opacity < 1 && /^#[0-9a-f]{6}$/i.test(color) ? `rgba(${parseInt(color.slice(1,3),16)},${parseInt(color.slice(3,5),16)},${parseInt(color.slice(5,7),16)},${opacity})` : color, fill: cfg.fill !== false, borderWidth: lineWidth, borderDash: lineStyle === 'dashed' ? [6, 4] : (lineStyle === 'dotted' ? [2, 3] : []), borderCapStyle: 'round', pointRadius: (d.markers ?? appearance.markers) === true ? 2 : 0, unit, baseColor: color };
    if (i < existing.length) { Object.assign(existing[i], style, { label: d.label, data: pts }); }
    else existing.push({ label: d.label, data: pts, ...style, tension: 0.35 });
  });
  while (existing.length > ds.length) existing.pop();
  chart.options.scales.x.time.unit = rangeOf(container, 'power') === '3d' ? 'day' : 'hour';
  const usesRight = ds.some(d => d && d.axis === 'right');
  for (const axis of ['left', 'right']) {
    const scale = chart.options.scales[axis === 'left' ? 'y' : 'yRight'], axisCfg = appearance.axes?.[axis] || {};
    if (axis === 'right') scale.display = usesRight;
    const fallbackMin = axis === 'left' ? appearance.axisMin : undefined, fallbackMax = axis === 'left' ? appearance.axisMax : undefined;
    const min = axisCfg.min !== '' && axisCfg.min != null ? axisCfg.min : fallbackMin, max = axisCfg.max !== '' && axisCfg.max != null ? axisCfg.max : fallbackMax;
    if (min !== '' && min != null && Number.isFinite(Number(min))) scale.min = Number(min); else delete scale.min;
    if (max !== '' && max != null && Number.isFinite(Number(max))) scale.max = Number(max); else delete scale.max;
    scale.title.text = `Power (${axisCfg.unit === 'W' ? 'W' : axisCfg.unit === 'kW' ? 'kW' : appearance.axisUnit === 'W' ? 'W' : 'kW'})`;
  }
  chart.options.plugins.legend.display = appearance.legend !== false;
  const legend = chart.options.plugins.legend;
  legend.onClick = (event, item, data) => { const standard = Chart.defaults?.plugins?.legend?.onClick; if (standard) standard.call(legend, event, item, data); else { const i=item.datasetIndex; chart.getDatasetMeta(i).hidden = chart.isDatasetVisible(i); chart.update(); } };
  chart.options.plugins.tooltip.enabled = appearance.tooltip !== false;
  chart.update();
  if (cfg.fill !== false) applyGradientFills(chart);
}

const powerRequestGates = new WeakMap();
const powerStatsCache = new WeakMap(); // container → { key, at, response, range }
const POWER_STATS_TTL_MS = 60_000;
const powerFetchedAt = new WeakMap(); // container → last 3-day history fetch
const powerFetchInFlight = new WeakSet(); // containers with a history fetch running
export async function refreshPowerChartFor({ chart, container }, suppliedState) {
  const cfg = getChartConfig(container), statsCfg = normalizePowerStatsConfig(cfg);
  let gate = powerRequestGates.get(container);
  if (!gate) { gate = createPowerStatsRequestGate(); powerRequestGates.set(container, gate); }
  const range = rangeOf(container, 'power'), to = Math.floor(Date.now() / 1000), from = to - (range === '3d' ? 72 : 24) * 3600;
  const snapshot = gate.capture({ from, to, range, config: JSON.stringify(cfg), datasets: JSON.stringify(getDatasets(container) || defaultPower()) });
  try {
    let data = suppliedState?.powerHistory;
    if (!data) {
      powerFetchInFlight.add(container);
      try { data = await powerHistoryFor(range); } finally { powerFetchInFlight.delete(container); }
    }
    if (!gate.isCurrent(snapshot) || snapshot.config !== JSON.stringify(getChartConfig(container)) || snapshot.datasets !== JSON.stringify(getDatasets(container) || defaultPower()) || snapshot.range !== rangeOf(container, 'power')) return;
    const points = (data || []).filter(p => { const t = Number(p.timestamp), seconds = t > 1e11 ? t / 1000 : t; return seconds >= from && seconds < to; });
    updatePowerChartData(chart, container, points);
    const mount = container.querySelector('.power-stats');
    if (!statsCfg.enabled || !mount) return;
    const ds = JSON.parse(snapshot.datasets), fields = [...new Set(ds.map(d => resolvePowerStatsField(d.metric)).filter(Boolean))];
    if (!fields.length) { mount.hidden = false; const body=mount.querySelector('tbody'); if(body)body.replaceChildren(); return; }
    // Live updates arrive every few seconds; statistics over 24 h / 3 d don't
    // need re-querying that often. Reuse a response for a minute, with its range.
    const statsKey = `${range}|${fields.join(',')}`, cachedStats = powerStatsCache.get(container);
    let response, statsRange = { from, to };
    if (!suppliedState?.forceStats && cachedStats && cachedStats.key === statsKey && Date.now() - cachedStats.at < POWER_STATS_TTL_MS) {
      response = cachedStats.response; statsRange = cachedStats.range;
    } else {
      const r = await fetch(`/api/history/power-stats?from=${from}&to=${to}&fields=${encodeURIComponent(fields.join(','))}`);
      if (!r.ok) throw new Error(`Statistics request failed (HTTP ${r.status})`);
      response = await r.json();
      powerStatsCache.set(container, { key: statsKey, at: Date.now(), response, range: statsRange });
    }
    if (!gate.isCurrent(snapshot) || snapshot.config !== JSON.stringify(getChartConfig(container)) || snapshot.datasets !== JSON.stringify(getDatasets(container) || defaultPower()) || snapshot.range !== rangeOf(container, 'power')) return;
    const legend = chart.options.plugins.legend;
    legend.onClick = (event, item, data) => { const standard = Chart.defaults?.plugins?.legend?.onClick; if (standard) standard.call(legend, event, item, data); else { const i=item.datasetIndex; chart.getDatasetMeta(i).hidden = chart.isDatasetVisible(i); chart.update(); } };
    chart.update();
    if (mount && statsCfg.enabled) updatePowerStatsSection(mount, response, ds, statsRange, { isHidden: i => !chart.isDatasetVisible(i), resolveColor: i => chart.data.datasets[i]?.borderColor || chart.data.datasets[i]?.backgroundColor, toggleSeries: i => { if (chart.isDatasetVisible(i)) chart.hide(i); else chart.show(i); chart.update(); refreshPowerChartFor({chart,container}, { forceStats: false }); } });
  } catch (e) { if (gate.isCurrent(snapshot) && snapshot.config === JSON.stringify(getChartConfig(container)) && snapshot.datasets === JSON.stringify(getDatasets(container) || defaultPower()) && snapshot.range === rangeOf(container, 'power') && statsCfg.enabled) { const mount = container.querySelector('.power-stats'); if (mount) { mount.hidden = false; let notice=mount.querySelector('.power-stats-unavailable'); if(!notice){notice=document.createElement('p');notice.className='power-stats-unavailable';notice.setAttribute('role','status');mount.append(notice);} notice.textContent=`Statistics unavailable: ${e.message || 'request failed'}.`; const body=mount.querySelector('tbody');if(body)body.replaceChildren(); } } console.warn('[charts] power refresh failed:', e); }
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
    if (rangeOf(c.container, 'power') !== '24h') {
      // The 3-day history is a large download; live updates every few seconds
      // don't change it meaningfully, so refresh it at most once a minute.
      if (Date.now() - (powerFetchedAt.get(c.container) || 0) < POWER_STATS_TTL_MS) continue;
      powerFetchedAt.set(c.container, Date.now());
      refreshPowerChartFor(c);
      continue;
    }
    // Most live updates are deltas without powerHistory. Only those that carry
    // it redraw the chart; an empty chart fetches once. Fetching on every delta
    // made each request supersede the last, so the chart never filled.
    if (Array.isArray(state.powerHistory) && state.powerHistory.length) refreshPowerChartFor(c, state);
    else if (!c.chart.data.datasets.some(d => d.data && d.data.length) && !powerFetchInFlight.has(c.container)) refreshPowerChartFor(c);
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

const energyFetchedAt = new WeakMap();
export function updateEnergyChartFromState(state) {
  if (!state) return;
  initKind('energy');
  for (const c of chartsOf('energy')) {
    if (rangeOf(c.container, 'energy') !== '7d') {
      // 30/90-day ranges are fetched; once a minute is plenty for daily totals.
      if (Date.now() - (energyFetchedAt.get(c.container) || 0) < 60_000) continue;
      energyFetchedAt.set(c.container, Date.now());
      refreshEnergyChartFor(c);
      continue;
    }
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
