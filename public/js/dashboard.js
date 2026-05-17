import { fetchDashboardConfig, saveDashboardConfig, fetchPublicConfig } from './api.js';
import { componentBuilders } from './components/index.js';
import { destroyCharts, initPowerChart, initEnergyChart } from './charts.js';
import { updateDailyTable, updateMonthlyTable } from './tables.js';
import { updateAllComponents } from './updater.js';
import { ensureBlockIds } from './utils/blockId.js';

let dashboardConfig;
let sortable = null;

// Load and render dashboard
export async function loadDashboardConfig() {
  const res = await fetch('/api/dashboard-config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  dashboardConfig = await res.json();
  if (!dashboardConfig.dashboards || dashboardConfig.dashboards.length === 0) {
    throw new Error('Invalid dashboard configuration: no dashboards');
  }

  const urlParams = new URLSearchParams(window.location.search);
  const tabParam = urlParams.get('tab');
  if (tabParam && dashboardConfig.dashboards.find(db => db.id === tabParam)) {
    dashboardConfig.activeDashboard = tabParam;
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

  // Destroy previous Sortable instance
  if (sortable) { sortable.destroy(); sortable = null; }

  const active = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard);
  if (!active) return;

  const layoutWithIds = ensureBlockIds(active.layout);

  // Migrate: ensure every block has a colSpan (from gridW if available, else default 12)
  let migrated = false;
  layoutWithIds.forEach(block => {
    if (block.colSpan === undefined) {
      block.colSpan = block.gridW ?? 12;
      migrated = true;
    }
  });
  if (migrated) {
    saveDashboardConfig(dashboardConfig).catch(e => console.warn('ColSpan migration save failed:', e));
  }

  // Render blocks as CSS Grid children
  layoutWithIds.forEach((block) => {
    if (block.enabled === false) return;
    const builder = componentBuilders[block.type];
    if (!builder) return;
    const content = builder(block);
    if (!content) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'dashboard-block';
    wrapper.dataset.blockId = block.id;
    const span = block.colSpan ?? 12;
    wrapper.style.gridColumn = `span ${Math.min(12, Math.max(1, span))}`;
    if (block.rowSpan) {
      wrapper.style.minHeight = block.rowSpan + 'px';
    }
    wrapper.appendChild(content);
    container.appendChild(wrapper);
  });

  // Init SortableJS for drag-to-reorder (authenticated users only)
  fetch('/api/auth/status')
    .then(r => r.json())
    .then(auth => {
      if (!auth.authenticated) return;
      sortable = new Sortable(container, {
        animation: 200,
        handle: '.dashboard-block',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        onEnd: () => {
          // Sync DOM order back to layout array
          const blockElems = container.querySelectorAll('.dashboard-block');
          const ordered = [];
          blockElems.forEach(el => {
            const b = active.layout.find(b => b.id === el.dataset.blockId);
            if (b) ordered.push(b);
          });
          active.layout = ordered;
          saveDashboardConfig(dashboardConfig).catch(e => console.warn('Reorder save failed:', e));
        }
      });
    }).catch(() => {});

  if (active.layout.some(b => b.type === 'chart-power')) initPowerChart();
  if (active.layout.some(b => b.type === 'chart-energy')) initEnergyChart();

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
