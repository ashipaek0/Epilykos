import { fetchDashboardConfig, saveDashboardConfig, fetchPublicConfig } from './api.js';
import { componentBuilders } from './components/index.js';
import { destroyCharts, initPowerChart, initEnergyChart } from './charts.js';
import { updateDailyTable, updateMonthlyTable } from './tables.js';
import { updateAllComponents } from './updater.js';

let dashboardConfig;

export async function loadDashboardConfig() {
  dashboardConfig = await fetchDashboardConfig();
  renderDashboard();
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

  // Lazy-load tables
  const dailyContent = document.querySelector('.daily-breakdown-content');
  if (dailyContent && !dailyContent.dataset.loaded) {
    const toggleBtn = dailyContent.previousElementSibling.querySelector('.toggle-btn');
    toggleBtn.addEventListener('click', async () => { await updateDailyTable(); dailyContent.dataset.loaded = 'true'; }, { once: true });
  }
  const monthlyContent = document.querySelectorAll('.daily-breakdown-content')[1];
  if (monthlyContent && !monthlyContent.dataset.loaded) {
    const toggleBtn = monthlyContent.previousElementSibling.querySelector('.toggle-btn');
    toggleBtn.addEventListener('click', async () => { await updateMonthlyTable(); monthlyContent.dataset.loaded = 'true'; }, { once: true });
  }

  loadBranding();
  updateAllComponents();
}

async function switchDashboard(id) {
  dashboardConfig.activeDashboard = id;
  await saveDashboardConfig(dashboardConfig);
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
