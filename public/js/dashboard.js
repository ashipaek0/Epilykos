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

  await loadBranding();
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
  let dragEnabled = false;

  fetch('/api/auth/status')
    .then(r => r.json())
    .then(auth => {
      if (!auth.authenticated) return;

      // Swap sign-in for settings + signout
      const signinBtn = document.getElementById('signin-btn');
      const signoutBtn = document.getElementById('signout-btn');
      const settingsBtn = document.getElementById('settings-btn');
      if (signinBtn) signinBtn.style.display = 'none';
      if (signoutBtn) signoutBtn.style.display = '';
      if (settingsBtn) settingsBtn.style.display = '';

      // Add drag toggle button to tab bar
      const toggleBtn = document.createElement('button');
      toggleBtn.id = 'drag-toggle';
      toggleBtn.className = 'settings-link';
      toggleBtn.textContent = '🔒 Locked';
      toggleBtn.title = 'Toggle drag-to-reorder';
      toggleBtn.style.marginLeft = 'auto';
      tabBar.appendChild(toggleBtn);

      const enableDrag = () => {
        if (sortable) { sortable.destroy(); sortable = null; }
        sortable = new Sortable(container, {
          animation: 200,
          handle: '.dashboard-block',
          ghostClass: 'sortable-ghost',
          chosenClass: 'sortable-chosen',
          onEnd: () => {
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
        toggleBtn.textContent = '🔓 Unlocked';
        dragEnabled = true;
      };

      const disableDrag = () => {
        if (sortable) { sortable.destroy(); sortable = null; }
        toggleBtn.textContent = '🔒 Locked';
        dragEnabled = false;
      };

      toggleBtn.addEventListener('click', () => {
        if (dragEnabled) disableDrag();
        else enableDrag();
      });
    }).catch(() => {});

  if (active.layout.some(b => b.type === 'chart-power')) initPowerChart();
  if (active.layout.some(b => b.type === 'chart-energy')) initEnergyChart();

  updateDailyTable().catch(e => console.error('Daily table error:', e));
  updateMonthlyTable().catch(e => console.error('Monthly table error:', e));
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
  const titleEl = document.getElementById('dashboard-title');
  const logoEl = document.getElementById('logo-img');
  const title = cfg.dashboard_title || 'Epilykos';
  titleEl.textContent = title;
  document.title = title;
  if (cfg.dashboard_logo) {
    logoEl.src = cfg.dashboard_logo;
    logoEl.style.display = 'inline';
  } else {
    logoEl.style.display = 'none';
  }
  if (cfg.dashboard_favicon) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = cfg.dashboard_favicon;
  }
  window.systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
  document.body.classList.toggle('transparent-blocks', cfg.transparent_blocks === 'true');
  if (cfg.dashboard_bg_color) document.body.style.backgroundColor = cfg.dashboard_bg_color;
  if (cfg.dashboard_bg_image) {
    document.body.style.backgroundImage = `url(${cfg.dashboard_bg_image})`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
  }
}

export { dashboardConfig, renderDashboard, switchDashboard };
