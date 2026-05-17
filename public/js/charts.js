import { fetchDashboardState } from './api.js';

let powerChart = null;
let energyBarChart = null;
let currentPowerRange = '24h';
let currentEnergyRange = '7d';
let currentPowerDatasets = null;

// Map metric names to powerHistory field names
const metricToPowerField = {
  solar: 'solar_kw',
  solar_power: 'solar_kw',
  consumption: 'consumption_kw',
  load_power: 'consumption_kw',
  load: 'consumption_kw',
  battery_charge: 'battery_charge_kw',
  battery_charge_power: 'battery_charge_kw',
  battery_discharge: 'battery_discharge_kw',
  grid_import: 'grid_import_kw',
  grid_import_power: 'grid_import_kw',
  grid_export: 'grid_export_kw'
};

// Map metric names to daily energy field names
const metricToEnergyField = {
  daily_solar: 'solar_kwh',
  solar: 'solar_kwh',
  daily_grid_import: 'grid_import_kwh',
  grid_import: 'grid_import_kwh',
  daily_consumption: 'consumption_kwh',
  consumption: 'consumption_kwh',
  daily_battery_charge: 'battery_charge_kwh',
  battery_charge: 'battery_charge_kwh',
  daily_battery_discharge: 'battery_discharge_kwh',
  daily_grid_export: 'grid_export_kwh',
  grid_export: 'grid_export_kwh'
};

function getPowerDatasets() {
  if (currentPowerDatasets && currentPowerDatasets.length) return currentPowerDatasets;
  const el = document.querySelector('.chart-container');
  if (el && el.dataset.chartDatasets) {
    try { return JSON.parse(el.dataset.chartDatasets); } catch (e) { /* fall through */ }
  }
  return [
    { label: 'Load', metric: 'consumption', color: '#7c3aed' },
    { label: 'Solar', metric: 'solar', color: '#d97706' },
    { label: 'Battery Charge', metric: 'battery_charge', color: '#059669' },
    { label: 'Grid Import', metric: 'grid_import', color: '#dc2626' }
  ];
}

function getEnergyDatasets() {
  const el = document.querySelectorAll('.chart-container')[1] || document.querySelector('.chart-container');
  if (el && el.dataset.chartDatasets) {
    try { return JSON.parse(el.dataset.chartDatasets); } catch (e) { /* fall through */ }
  }
  return [
    { label: 'Solar Generated', metric: 'daily_solar', color: '#d97706' },
    { label: 'Grid Imported', metric: 'daily_grid_import', color: '#dc2626' },
    { label: 'Energy Consumed', metric: 'daily_consumption', color: '#7c3aed' }
  ];
}

export function destroyCharts() {
  if (powerChart) { powerChart.destroy(); powerChart = null; }
  if (energyBarChart) { energyBarChart.destroy(); energyBarChart = null; }
}

export function initPowerChart() {
  const canvas = document.getElementById('powerChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  powerChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' },
      elements: { line: { borderWidth: 1, tension: 0.4, fill: true }, point: { radius: 0, hoverRadius: 4 } },
      scales: {
        x: { type: 'time', time: { unit: 'hour' }, grid: { color: gridColor } },
        y: { title: { display: true, text: 'Power (kW)', color: textColor }, grid: { color: gridColor } }
      },
      plugins: { tooltip: { mode: 'index' }, legend: { labels: { color: textColor } } }
    }
  });
  refreshPowerChart();
}

export function initEnergyChart() {
  const canvas = document.getElementById('energyBarChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';

  const datasets = getEnergyDatasets();
  const chartDatasets = datasets.map(ds => ({
    label: ds.label,
    backgroundColor: ds.color || '#888',
    data: []
  }));

  energyBarChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { color: gridColor } },
        y: { title: { display: true, text: 'Energy (kWh)', color: textColor }, grid: { color: gridColor }, beginAtZero: true }
      },
      plugins: { legend: { labels: { color: textColor } }, tooltip: { mode: 'index' } }
    }
  });
  refreshEnergyChart();
}

export function resolveColor(color) {
  if (!color) return '#cccccc';
  if (color.startsWith('#')) return color;
  if (color.startsWith('var(--')) {
    const varName = color.slice(4, -1);
    const style = getComputedStyle(document.documentElement);
    const raw = style.getPropertyValue(varName).trim();
    if (raw.startsWith('#')) return raw;
  }
  return '#cccccc';
}

export function applyGradientFills(chart) {
  if (!chart || !chart.ctx) return;
  requestAnimationFrame(() => {
    const ctx = chart.ctx;
    const datasets = chart.data.datasets;
    const chartArea = chart.chartArea;
    if (!chartArea) { setTimeout(() => applyGradientFills(chart), 50); return; }
    datasets.forEach((dataset, i) => {
      const meta = chart.getDatasetMeta(i);
      if (!meta.hidden && dataset.data.length > 0) {
        const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
        let color = dataset.borderColor || '#ccc';
        const hex = resolveColor(color);
        const r = parseInt(hex.slice(1,3), 16);
        const g = parseInt(hex.slice(3,5), 16);
        const b = parseInt(hex.slice(5,7), 16);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.2)`);
        gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.5)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.8)`);
        dataset.backgroundColor = gradient;
        dataset.fill = true;
      }
    });
    chart.update();
  });
}

export function updateChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  if (powerChart) {
    powerChart.options.scales.x.grid.color = gridColor;
    powerChart.options.scales.y.grid.color = gridColor;
    powerChart.options.plugins.legend.labels.color = textColor;
    const datasets = getPowerDatasets();
    powerChart.data.datasets.forEach((ds, i) => {
      if (datasets[i] && datasets[i].color) {
        ds.borderColor = resolveColor(datasets[i].color);
      }
    });
    powerChart.update();
    applyGradientFills(powerChart);
  }
  if (energyBarChart) {
    energyBarChart.options.scales.x.grid.color = gridColor;
    energyBarChart.options.scales.y.grid.color = gridColor;
    energyBarChart.options.plugins.legend.labels.color = textColor;
    const datasets = getEnergyDatasets();
    energyBarChart.data.datasets.forEach((ds, i) => {
      if (datasets[i] && datasets[i].color) {
        ds.backgroundColor = datasets[i].color;
      }
    });
    energyBarChart.update();
  }
}

// Power chart range + dataset filter
export async function refreshPowerChart() {
  if (!powerChart) return;
  let data;
  if (currentPowerRange === '24h') {
    const state = await fetchDashboardState();
    data = state.powerHistory;
  } else if (currentPowerRange === '3d') {
    const days = 3;
    const res = await fetch(`/api/history?days=${days}`);
    const historyData = await res.json();
    data = historyData.map(r => ({
      timestamp: r.timestamp,
      consumption_kw: r.consumption_kw,
      solar_kw: r.solar_kw,
      battery_charge_kw: r.battery_charge_kw,
      grid_import_kw: r.grid_import_kw
    }));
  } else {
    const state = await fetchDashboardState();
    data = state.powerHistory;
  }
  updatePowerChartData(data);
}

function updatePowerChartData(data) {
  if (!data || !data.length) return;
  const datasets = getPowerDatasets();
  const newDatasets = [];

  for (const ds of datasets) {
    const field = metricToPowerField[ds.metric] || ds.metric;
    const extractor = (d) => ({ x: d.timestamp, y: d[field] ?? 0 });
    newDatasets.push({
      label: ds.label,
      data: data.map(extractor),
      borderColor: resolveColor(ds.color),
      tension: 0.4, borderWidth: 1, fill: true
    });
  }

  powerChart.data.datasets = newDatasets;
  powerChart.update();
  applyGradientFills(powerChart);
}

export function setPowerRange(range, datasets) {
  currentPowerRange = range;
  if (datasets && Array.isArray(datasets) && datasets.length) {
    currentPowerDatasets = datasets;
  }
  refreshPowerChart();
}

// Energy chart
export async function refreshEnergyChart() {
  if (!energyBarChart) return;
  const days = parseInt(currentEnergyRange);
  const res = await fetch(`/api/daily?days=${days}`);
  const data = await res.json();
  updateEnergyChartData(data);
}

function updateEnergyChartData(data) {
  if (!data || !data.length) return;
  const sources = getEnergyDatasets();
  const labels = data.map(d => {
    const date = new Date(d.day + 'T00:00:00');
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });

  const chartDatasets = sources.map(src => {
    const field = metricToEnergyField[src.metric];
    if (field) {
      return {
        label: src.label,
        data: data.map(d => d[field] || 0),
        backgroundColor: src.color || '#888'
      };
    }
    return { label: src.label, data: [], backgroundColor: src.color || '#888' };
  });

  energyBarChart.data.labels = labels;
  energyBarChart.data.datasets = chartDatasets;
  energyBarChart.update();
}

export function setEnergyRange(range) {
  currentEnergyRange = range;
  refreshEnergyChart();
}

// Legacy update functions for updater.js
export function updatePowerChartFromState(state) {
  if (!powerChart) return;
  if (currentPowerRange !== '24h') {
    refreshPowerChart();
    return;
  }
  updatePowerChartData(state.powerHistory);
}

export function updateEnergyChartFromState(state) {
  if (!energyBarChart) return;
  if (currentEnergyRange !== '7d') {
    refreshEnergyChart();
    return;
  }
  if (state.dailyEnergyBar) updateEnergyChartData(state.dailyEnergyBar);
}
