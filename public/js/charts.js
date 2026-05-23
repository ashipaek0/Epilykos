/**
 * Chart Management
 *
 * Multi-instance Chart.js wrapper for power (line) and energy (bar) charts.
 * Charts stored in Maps keyed by canvas ID for multi-instance support.
 *
 * Power chart: 24h/3d range, configurable datasets, green/red zone gradients.
 * Energy chart: 7d/30d/90d range, configurable datasets.
 *
 * Exports lifecycle functions: init, refresh, update from state, range switching.
 *
 * @module charts
 */
import { fetchDashboardState } from './api.js';

const powerCharts = {}, energyCharts = {};
let currentPowerRange = '24h', currentEnergyRange = '7d';

/** Resolve any arbitrary metric name to the matching API power field via keyword matching. */
function resolvePowerField(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/solar|pv/.test(n)) return 'solar_kw';
  if (/consumption|load/.test(n)) return 'consumption_kw';
  if (/battery/.test(n)) {
    if (/discharge|discharging/.test(n)) return 'battery_discharge_kw';
    return 'battery_charge_kw';  // generic "battery power" → assume charge
  }
  if (/grid/.test(n)) {
    if (/export/.test(n)) return 'grid_export_kw';
    return 'grid_import_kw';  // generic "grid power" → assume import
  }
  return null;
}

/** Resolve any arbitrary metric name to the matching API energy field via keyword matching. */
function resolveEnergyField(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/solar/.test(n)) return 'solar_kwh';
  if (/consumption|load/.test(n)) return 'consumption_kwh';
  if (/battery/.test(n)) {
    if (/discharge|discharging/.test(n)) return 'battery_discharge_kwh';
    return 'battery_charge_kwh';
  }
  if (/grid/.test(n)) {
    if (/export/.test(n)) return 'grid_export_kwh';
    return 'grid_import_kwh';
  }
  return null;
}

function getDatasets(c) { if (c && c.dataset.chartDatasets) { try { return JSON.parse(c.dataset.chartDatasets); } catch (e) {} } return null; }
function defaultPower() { return [{ label: 'Load', metric: 'consumption', color: '#0062FF' }, { label: 'Solar', metric: 'solar', color: '#FFEA00' }, { label: 'Battery Charge', metric: 'battery_charge', color: '#00E056' }, { label: 'Grid Import', metric: 'grid_import', color: '#FF4255' }]; }
function defaultEnergy() { return [{ label: 'Solar Generated', metric: 'daily_solar', color: '#FFEA00' }, { label: 'Grid Imported', metric: 'daily_grid_import', color: '#FF4255' }, { label: 'Energy Consumed', metric: 'daily_consumption', color: '#0062FF' }]; }

const zonePlugin = { id: 'zonePlugin', beforeDraw(chart) { const { ctx, chartArea, scales } = chart; if (!chartArea) return; const zy = scales.y.getPixelForValue(0); if (zy > chartArea.top) { const g = ctx.createLinearGradient(0, chartArea.top, 0, zy); g.addColorStop(0, 'rgba(0,224,86,0.12)'); g.addColorStop(0.6, 'rgba(0,224,86,0.04)'); g.addColorStop(1, 'rgba(0,224,86,0)'); ctx.fillStyle = g; ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, zy - chartArea.top); } if (zy < chartArea.bottom) { const g = ctx.createLinearGradient(0, zy, 0, chartArea.bottom); g.addColorStop(0, 'rgba(255,66,85,0)'); g.addColorStop(0.4, 'rgba(255,66,85,0.08)'); g.addColorStop(1, 'rgba(255,66,85,0.18)'); ctx.fillStyle = g; ctx.fillRect(chartArea.left, zy, chartArea.right - chartArea.left, chartArea.bottom - zy); } } };

export function destroyCharts() { Object.values(powerCharts).forEach(c => c.destroy()); Object.values(energyCharts).forEach(c => c.destroy()); for (const k in powerCharts) delete powerCharts[k]; for (const k in energyCharts) delete energyCharts[k]; }

export function initPowerChart() {
  document.querySelectorAll('.chart-container canvas[id]').forEach(canvas => {
    if (!canvas.id.startsWith('powerChart')) return;
    if (powerCharts[canvas.id]) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gc = isDark ? '#334155' : '#cbd5e1', tc = isDark ? '#f8fafc' : '#0f172a';
    powerCharts[canvas.id] = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: [] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' }, elements: { line: { borderWidth: 2, tension: 0.4, fill: true }, point: { radius: 0, hoverRadius: 4 } }, scales: { x: { type: 'time', time: { unit: 'hour' }, grid: { color: gc } }, y: { title: { display: true, text: 'Power (kW)', color: tc }, grid: { color: gc }, grace: '5%' } }, plugins: { tooltip: { mode: 'index' }, legend: { labels: { color: tc } } } }, plugins: [zonePlugin] });
    refreshPowerChartFor(canvas.id);
  });
}

export function initEnergyChart() {
  document.querySelectorAll('.chart-container canvas[id]').forEach(canvas => {
    if (!canvas.id.startsWith('energyBarChart')) return;
    if (energyCharts[canvas.id]) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gc = isDark ? '#334155' : '#cbd5e1', tc = isDark ? '#f8fafc' : '#0f172a';
    const ds = getDatasets(canvas.closest('.chart-container')) || defaultEnergy();
    energyCharts[canvas.id] = new Chart(canvas.getContext('2d'), { type: 'bar', data: { labels: [], datasets: ds.map(d => ({ label: d.label, backgroundColor: d.color || '#888', data: [] })) }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { color: gc } }, y: { title: { display: true, text: 'Energy (kWh)', color: tc }, grid: { color: gc }, beginAtZero: true } }, plugins: { legend: { labels: { color: tc } }, tooltip: { mode: 'index' } } } });
    refreshEnergyChartFor(canvas.id);
  });
}

function resolveColor(color) { if (!color) return '#ccc'; if (color.startsWith('#')) return color; return '#ccc'; }

export function applyGradientFills(chart) { if (!chart || !chart.ctx) return; requestAnimationFrame(() => { const ctx = chart.ctx, ca = chart.chartArea; if (!ca) { setTimeout(() => applyGradientFills(chart), 50); return; } chart.data.datasets.forEach((ds, i) => { if (!chart.getDatasetMeta(i).hidden && ds.data.length) { const g = ctx.createLinearGradient(0, ca.bottom, 0, ca.top), hx = resolveColor(ds.borderColor || '#ccc'), r = parseInt(hx.slice(1, 3), 16), gv = parseInt(hx.slice(3, 5), 16), b = parseInt(hx.slice(5, 7), 16); g.addColorStop(0, `rgba(${r},${gv},${b},0.2)`); g.addColorStop(0.5, `rgba(${r},${gv},${b},0.5)`); g.addColorStop(1, `rgba(${r},${gv},${b},0.8)`); ds.backgroundColor = g; ds.fill = true; } }); chart.update(); }); }

export function updateChartColors() { const isDark = document.documentElement.getAttribute('data-theme') === 'dark', gc = isDark ? '#334155' : '#cbd5e1', tc = isDark ? '#f8fafc' : '#0f172a'; Object.values(powerCharts).forEach(c => { c.options.scales.x.grid.color = gc; c.options.scales.y.grid.color = gc; c.options.plugins.legend.labels.color = tc; c.update(); applyGradientFills(c); }); Object.values(energyCharts).forEach(c => { c.options.scales.x.grid.color = gc; c.options.scales.y.grid.color = gc; c.options.plugins.legend.labels.color = tc; c.update(); }); }

async function refreshPowerChartFor(cid) { const chart = powerCharts[cid]; if (!chart) return; let data; if (currentPowerRange === '24h') { const s = await fetchDashboardState(); data = s.powerHistory; } else if (currentPowerRange === '3d') { const r = await fetch('/api/history?days=3'); const hd = await r.json(); data = hd.map(d => ({ timestamp: d.timestamp, consumption_kw: d.consumption_kw ?? 0, solar_kw: d.solar_kw ?? 0, battery_charge_kw: d.battery_charge_kw ?? 0, battery_discharge_kw: d.battery_discharge_kw ?? 0, grid_import_kw: d.grid_import_kw ?? 0, grid_export_kw: d.grid_export_kw ?? 0 })); } else { const s = await fetchDashboardState(); data = s.powerHistory; } updatePowerChartData(chart, cid, data); }

export async function refreshPowerChart() { for (const cid of Object.keys(powerCharts)) await refreshPowerChartFor(cid); }

function updatePowerChartData(chart, cid, data) { if (!data || !data.length) return; const ct = document.getElementById(cid)?.closest('.chart-container'); const ds = getDatasets(ct) || defaultPower(); chart.data.datasets = ds.map(d => { const f = resolvePowerField(d.metric); return { label: d.label, data: data.map(p => ({ x: p.timestamp, y: f ? (p[f] ?? 0) : 0 })), borderColor: resolveColor(d.color), tension: 0.4, borderWidth: 1, fill: true }; }); chart.update(); applyGradientFills(chart); }

export function setPowerRange(range, datasets) { currentPowerRange = range; if (datasets) { document.querySelectorAll('.chart-container').forEach(c => { if (c.querySelector('canvas[id^="powerChart"]')) c.dataset.chartDatasets = JSON.stringify(datasets); }); } refreshPowerChart(); }

async function refreshEnergyChartFor(cid) { const chart = energyCharts[cid]; if (!chart) return; const days = parseInt(currentEnergyRange); const r = await fetch(`/api/daily?days=${days}`); const data = await r.json(); updateEnergyChartData(chart, cid, data); }

export async function refreshEnergyChart() { for (const cid of Object.keys(energyCharts)) await refreshEnergyChartFor(cid); }

function updateEnergyChartData(chart, cid, data) { if (!data || !data.length) return; const ct = document.getElementById(cid)?.closest('.chart-container'); const src = getDatasets(ct) || defaultEnergy(); chart.data.labels = data.map(d => new Date(d.day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })); chart.data.datasets = src.map(s => { const f = resolveEnergyField(s.metric); return { label: s.label, data: f ? data.map(d => d[f] || 0) : [], backgroundColor: s.color || '#888' }; }); chart.update(); }

export function setEnergyRange(range) { currentEnergyRange = range; refreshEnergyChart(); }

export function updatePowerChartFromState(state) { if (!state) return; for (const [cid, chart] of Object.entries(powerCharts)) { if (currentPowerRange !== '24h') { refreshPowerChartFor(cid); continue; } updatePowerChartData(chart, cid, state.powerHistory); } }

export function updateEnergyChartFromState(state) { if (!state) return; for (const [cid, chart] of Object.entries(energyCharts)) { if (currentEnergyRange !== '7d') { refreshEnergyChartFor(cid); continue; } if (state.dailyEnergyBar) updateEnergyChartData(chart, cid, state.dailyEnergyBar); } }
