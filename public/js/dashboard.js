import { fetchDashboardConfig, saveDashboardConfig, fetchPublicConfig } from './api.js';
import { componentBuilders } from './components/index.js';
import { destroyCharts, initPowerChart, initEnergyChart } from './charts.js';
import { updateDailyTable, updateMonthlyTable } from './tables.js';
import { updateAllComponents } from './updater.js';

let dashboardConfig;

export async function loadDashboardConfig() {
  const res = await fetch('/api/dashboard-config');
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  dashboardConfig = await res.json();
  if (!dashboardConfig.dashboards || dashboardConfig.dashboards.length === 0) {
    throw new Error('Invalid dashboard configuration: no dashboards');
  }
  
  const urlParams = new URLSearchParams(window.location.search);
  const tabParam = urlParams.get('tab');
  if (tabParam) {
    const matchingTab = dashboardConfig.dashboards.find(db => db.id === tabParam);
    if (matchingTab) {
      dashboardConfig.activeDashboard = tabParam;
    }
  }
  
  renderDashboard();
  return dashboardConfig;
}

function renderDashboard() {
  if (!dashboardConfig || !dashboardConfig.dashboards) return;
  destroyCharts();

  // Build tab bar
  let tabBar = document.getElementById('tab-bar');
  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'tab-bar';
    document.querySelector('header').after(tabBar);
  }
  tabBar.innerHTML = '';
  dashboardConfig.dashboards.forEach(db => {
    const tab = document.createElement('button');
    tab.className = 'dashboard-tab' + (db.id === dashboardConfig.activeDashboard ? ' active' : '');
    tab.textContent = db.name;
    tab.onclick = () => switchDashboard(db.id);
    tabBar.appendChild(tab);
  });

  const container = document.getElementById('dashboard-container');
  container.innerHTML = '';
  const active = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard);
  if (!active) return;

  active.layout.forEach(block => {
    if (block.enabled === false) return;
    const builder = componentBuilders[block.type];
    if (!builder) return;
    const el = builder(block);
    if (el) container.appendChild(el);
  });

  if (active.layout.some(b => b.type === 'chart-power')) initPowerChart();
  if (active.layout.some(b => b.type === 'chart-energy')) initEnergyChart();

  // Load table data immediately (no lazy‑load required)
  updateDailyTable().catch(e => console.error('Daily table error:', e));
  updateMonthlyTable().catch(e => console.error('Monthly table error:', e));

  loadBranding();
  updateAllComponents();
}

async function switchDashboard(id) {
  dashboardConfig.activeDashboard = id;
  await saveDashboardConfig(dashboardConfig);
  const url = new URL(window.location);
  url.searchParams.set('tab', id);
  window.history.pushState({}, '', url);
  renderDashboard();
}

async function loadBranding() {
  const cfg = await fetchPublicConfig();
  if (cfg.dashboard_title) {
    document.getElementById('dashboard-title').textContent = cfg.dashboard_title;
    document.title = cfg.dashboard_title;
  }
  if (cfg.dashboard_logo) {
    document.getElementById('logo-img').src = cfg.dashboard_logo;
    document.getElementById('logo-img').style.display = 'inline';
  }
  window.systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
}

export { dashboardConfig, renderDashboard, switchDashboard };
