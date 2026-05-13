import { fetchDashboardState } from './api.js';

let powerChart = null;
let energyBarChart = null;
let currentPowerRange = '24h';
let currentEnergyRange = '7d';

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
  energyBarChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Solar Generated', backgroundColor: '#d97706', data: [] },
      { label: 'Grid Imported', backgroundColor: '#dc2626', data: [] },
      { label: 'Energy Consumed', backgroundColor: '#7c3aed', data: [] }
    ] },
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
  if (color.startsWith('#')) return color;
  if (color.startsWith('var(--')) {
    const varName = color.slice(4, -1);
    const style = getComputedStyle(document.documentElement);
    const raw = style.getPropertyValue('--' + varName).trim();
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
    powerChart.data.datasets.forEach((ds, i) => {
      if (i === 0) ds.borderColor = isDark ? '#8b5cf6' : '#7c3aed';
      else if (i === 1) ds.borderColor = isDark ? '#fbbf24' : '#d97706';
      else if (i === 2) ds.borderColor = isDark ? '#10b981' : '#059669';
      else if (i === 3) ds.borderColor = isDark ? '#ef4444' : '#dc2626';
    });
    powerChart.update();
    applyGradientFills(powerChart);
  }
  if (energyBarChart) {
    energyBarChart.options.scales.x.grid.color = gridColor;
    energyBarChart.options.scales.y.grid.color = gridColor;
    energyBarChart.options.plugins.legend.labels.color = textColor;
    energyBarChart.update();
  }
}

// Power chart range functions
export async function refreshPowerChart() {
  if (!powerChart) return;
  let data;
  if (currentPowerRange === '24h') {
    const state = await fetchDashboardState();
    data = state.powerHistory;
  } else {
    const days = parseInt(currentPowerRange);
    const res = await fetch(`/api/history?days=${days}`);
    const historyData = await res.json();
    data = historyData.map(r => ({
      timestamp: r.timestamp,
      consumption_kw: r.consumption_kw,
      solar_kw: r.solar_kw,
      battery_charge_kw: r.battery_charge_kw,
      grid_import_kw: r.grid_import_kw
    }));
  }
  updatePowerChartData(data);
}

function updatePowerChartData(data) {
  if (!data.length) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newDatasets = [
    { label: 'Load', data: [], borderColor: isDark ? '#8b5cf6' : '#7c3aed', tension: 0.4, borderWidth: 1, fill: true },
    { label: 'Solar PV', data: [], borderColor: isDark ? '#fbbf24' : '#d97706', tension: 0.4, borderWidth: 1, fill: true },
    { label: 'Battery Charge', data: [], borderColor: isDark ? '#10b981' : '#059669', tension: 0.4, borderWidth: 1, fill: true },
    { label: 'Grid Import', data: [], borderColor: isDark ? '#ef4444' : '#dc2626', tension: 0.4, borderWidth: 1, fill: true }
  ];
  data.forEach(d => {
    newDatasets[0].data.push({ x: d.timestamp, y: d.consumption_kw });
    newDatasets[1].data.push({ x: d.timestamp, y: d.solar_kw });
    newDatasets[2].data.push({ x: d.timestamp, y: d.battery_charge_kw });
    newDatasets[3].data.push({ x: d.timestamp, y: d.grid_import_kw });
  });
  powerChart.data.datasets = newDatasets;
  powerChart.update();
  applyGradientFills(powerChart);
}

export function setPowerRange(range) {
  currentPowerRange = range;
  refreshPowerChart();
}

// Energy chart range functions
export async function refreshEnergyChart() {
  if (!energyBarChart) return;
  const days = parseInt(currentEnergyRange);
  const res = await fetch(`/api/daily?days=${days}`);
  const data = await res.json();
  updateEnergyChartData(data);
}

function updateEnergyChartData(data) {
  if (!data.length) return;
  const labels = data.map(d => {
    const date = new Date(d.day + 'T00:00:00');
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  energyBarChart.data.labels = labels;
  energyBarChart.data.datasets[0].data = data.map(d => d.solar_kwh);
  energyBarChart.data.datasets[1].data = data.map(d => d.grid_import_kwh);
  energyBarChart.data.datasets[2].data = data.map(d => d.consumption_kwh);
  energyBarChart.update();
}

export function setEnergyRange(range) {
  currentEnergyRange = range;
  refreshEnergyChart();
}

// Legacy update functions (kept for compatibility with updater.js)
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
  // Transform dailyEnergyBar to the format expected by updateEnergyChartData
  if (state.dailyEnergyBar) updateEnergyChartData(state.dailyEnergyBar);
}
