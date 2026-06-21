/**
 * Dashboard Layout Engine
 *
 * Renders blocks using absolute positioning derived from GridStack coordinates.
 * Each block saves gridX, gridY, gridW, gridH — converted to pixel positions
 * with column-based percentage widths. Supports multi-instance blocks via uid().
 *
 * Key features:
 * - SortableJS drag-to-reorder (auth-only, lock/unlock toggle)
 * - Per-block background colour and transparency
 * - Desktop/mobile dashboard auto-switch
 * - Automatic migration of legacy blocks to grid coordinates
 *
 * @module dashboard
 */
import { fetchDashboardConfig, saveDashboardConfig, fetchPublicConfig } from './api.js';
import { componentBuilders } from './components/index.js';
import { destroyCharts, initPowerChart, initEnergyChart } from './charts.js';
import { updateDailyTable, updateMonthlyTable } from './tables.js';
import { clearSparklineCharts } from './forecast.js';
import { updateAllComponents } from './updater.js';
import { ensureBlockIds } from './utils/blockId.js';

let dashboardConfig;

/**
 * Fetch dashboard config from API, select active tab (honouring ?tab= param
 * and desktop/mobile defaults), apply branding, then render all blocks.
 * @returns {Promise<object>} the dashboard configuration
 */
export async function loadDashboardConfig() {
  const res = await fetch('/api/dashboard-config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  dashboardConfig = await res.json();
  if (!dashboardConfig.dashboards || dashboardConfig.dashboards.length === 0) {
    throw new Error('Invalid dashboard configuration: no dashboards');
  }

  // Load branding first for desktop/mobile dashboard selection
  const cfg = await fetchPublicConfig();
  const urlParams = new URLSearchParams(window.location.search);
  const tabParam = urlParams.get('tab');
  if (tabParam && dashboardConfig.dashboards.find(db => db.id === tabParam)) {
    dashboardConfig.activeDashboard = tabParam;
  } else {
    const isMobile = window.innerWidth < 768;
    const defTab = isMobile ? cfg.mobile_dashboard : cfg.desktop_dashboard;
    if (defTab && dashboardConfig.dashboards.find(db => db.id === defTab)) {
      dashboardConfig.activeDashboard = defTab;
    }
  }
  applyBranding(cfg);

  renderDashboard();
  return dashboardConfig;
}

/**
 * Render all blocks for the active dashboard tab using absolute positioning.
 * Blocks placed via gridX/gridY (GridStack coordinates) → pixel left/top.
 * Width uses (gridW/12)*100% for responsive columns.
 * Initialises SortableJS if authenticated, with lock/unlock toggle.
 */
function renderDashboard() {
  if (!dashboardConfig || !dashboardConfig.dashboards) return;
  destroyCharts();
  clearSparklineCharts();

  // Build tab bar — hidden by default, shown when authenticated
  let tabBar = document.getElementById('tab-bar');
  let tabToggle = document.getElementById('tab-toggle');
  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'tab-bar';
    tabBar.style.display = 'none';
    document.querySelector('header').after(tabBar);
  }
  if (!tabToggle) {
    tabToggle = document.createElement('button');
    tabToggle.id = 'tab-toggle';
    tabToggle.className = 'settings-link';
    tabToggle.textContent = '☰';
    tabToggle.title = 'Show dashboard tabs';
    tabToggle.style.display = 'none';
    tabToggle.onclick = () => {
      const show = tabBar.style.display === 'none';
      tabBar.style.display = show ? '' : 'none';
      tabToggle.textContent = '☰';
      tabToggle.title = show ? 'Hide dashboard tabs' : 'Show dashboard tabs';
    };
    document.querySelector('header').appendChild(tabToggle);
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

  const layoutWithIds = ensureBlockIds(active.layout);

  // Migrate legacy blocks: colSpan → gridW, rowSpan → gridH, missing gridY assigned sequentially
  let migrated = false;
  let accumY = 0;
  layoutWithIds.forEach(block => {
    if (block.gridX === undefined) { block.gridX = 0; migrated = true; }
    if (block.gridW === undefined) { block.gridW = block.colSpan ?? 12; migrated = true; }
    if (block.gridH === undefined) { block.gridH = Math.max(1, Math.round((block.rowSpan || 200) / 50)); migrated = true; }
    if (block.gridY === undefined) {
      block.gridY = accumY;
      accumY += block.gridH;
      migrated = true;
    }
  });
  if (migrated) {
    saveDashboardConfig(dashboardConfig).catch(e => console.warn('Migration save failed:', e));
  }

  // Render blocks with absolute positioning based on GridStack coordinates
  const ROW_HEIGHT = 50; // matches editor cellHeight
  const GAP = 5; // half of GridStack's ~10px default margin between items

  // Build position descriptors sorted by gridY for overlap prevention
  const positioned = [];
  layoutWithIds.forEach((block) => {
    if (block.enabled === false) return;
    const builder = componentBuilders[block.type];
    if (!builder) return;
    const x = block.gridX ?? 0;
    const y = block.gridY ?? 0;
    const w = block.gridW ?? 12;
    const h = block.gridH ?? 4;
    positioned.push({ block, x, y, w, h });
  });
  positioned.sort((a, b) => a.y - b.y || a.x - b.x);

  // De-overlap pass: for each block, check against all previously placed blocks
  // and push down if their vertical spans overlap within the same horizontal region
  for (let i = 0; i < positioned.length; i++) {
    const cur = positioned[i];
    let adjustedY = cur.y;
    for (let j = 0; j < i; j++) {
      const prev = positioned[j];
      // Horizontal overlap check: columns intersect?
      const curLeft = cur.x;
      const curRight = cur.x + cur.w;
      const prevLeft = prev.x;
      const prevRight = prev.x + prev.w;
      if (curRight > prevLeft && curLeft < prevRight) {
        // Vertical: check if cur would overlap prev's bottom edge
        const prevBottom = prev._top + prev.h;
        if (adjustedY < prevBottom) {
          adjustedY = prevBottom;
        }
      }
    }
    cur._top = adjustedY;
  }

  let maxBottom = 0;

  positioned.forEach(({ block, x, w, h, _top }) => {
    const content = componentBuilders[block.type](block);
    if (!content) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'dashboard-block';
    wrapper.dataset.blockId = block.id;
    wrapper.style.position = 'absolute';
    wrapper.style.left = `calc(${((x / 12) * 100)}% + ${GAP}px)`;
    wrapper.style.top = (_top * ROW_HEIGHT + GAP) + 'px';
    wrapper.style.width = `calc(${((w / 12) * 100)}% - ${GAP * 2}px)`;
    wrapper.style.height = (h * ROW_HEIGHT - GAP * 2) + 'px';

    if (block.bgColor) {
      content.style.setProperty('background-color', block.bgColor, 'important');
    }
    if (block.innerBgColor) {
      content.style.setProperty('--card-bg', block.innerBgColor, 'important');
      content.style.setProperty('--bg', block.innerBgColor, 'important');
    }
    if (block.fontColor) {
      content.style.setProperty('color', block.fontColor, 'important');
    }
    if (block.fontSize) {
      content.style.fontSize = block.fontSize;
      // Scale down children that use rem units by adjusting the root for this block
      const scale = parseFloat(block.fontSize) / 1;
      content.style.setProperty('--fs-small', (0.85 * scale) + 'rem', 'important');
      content.style.setProperty('--fs-medium', (1.1 * scale) + 'rem', 'important');
      content.style.setProperty('--fs-large', (1.5 * scale) + 'rem', 'important');
    }
    if (block.transparent) {
      content.style.background = 'transparent';
      content.style.borderColor = 'transparent';
      content.style.boxShadow = 'none';
      // Override CSS variables so all children using var(--card-bg) / var(--bg) become transparent
      content.style.setProperty('--card-bg', 'transparent');
      content.style.setProperty('--bg', 'transparent');
      // Also clear inner cards, circles, and chart containers
      content.querySelectorAll('.stat-card, .topo-node-circle, .chart-container, .topo-hub, .fcs-inverter-icon, .fcs2-inv').forEach(el => {
        el.style.background = 'transparent';
        el.style.borderColor = 'transparent';
        el.style.boxShadow = 'none';
      });
    }
    wrapper.appendChild(content);
    container.appendChild(wrapper);

    maxBottom = Math.max(maxBottom, (_top + h) * ROW_HEIGHT);
  });

  container.style.position = 'relative';
  container.style.height = maxBottom + 'px';

  // Auth-dependent UI: sign-in/out, editor link
  fetch('/api/auth/status')
    .then(r => r.json())
    .then(auth => {
      if (auth.authenticated) {
        // Swap sign-in for settings + signout
        const signinBtn = document.getElementById('signin-btn');
        const signoutBtn = document.getElementById('signout-btn');
        const settingsBtn = document.getElementById('settings-btn');
        if (signinBtn) signinBtn.style.display = 'none';
        if (signoutBtn) signoutBtn.style.display = '';
        if (settingsBtn) settingsBtn.style.display = '';

        // Show tabs and tab toggle
        tabBar.style.display = '';
        if (tabToggle) tabToggle.style.display = '';

        // Add editor link to tab bar
        const editorLink = document.createElement('a');
        editorLink.href = `/editor?tab=${dashboardConfig.activeDashboard}`;
        editorLink.className = 'settings-link';
        editorLink.textContent = ' Edit Layout';
        editorLink.style.marginLeft = '0.5rem';
        tabBar.appendChild(editorLink);
      }
    }).catch(() => {});

  if (active.layout.some(b => b.type === 'chart-power')) initPowerChart();
  if (active.layout.some(b => b.type === 'chart-energy')) initEnergyChart();

  // Defer data fetches — WebSocket pushes initial state; tables and forecast load staggered
  setTimeout(() => {
    updateDailyTable().catch(e => console.error('Daily table error:', e));
    updateMonthlyTable().catch(e => console.error('Monthly table error:', e));
  }, 2000);
  // updateAllComponents() is called by main.js after WebSocket connects
}

async function switchDashboard(id) {
  dashboardConfig.activeDashboard = id;
  await saveDashboardConfig(dashboardConfig);
  const url = new URL(window.location);
  url.searchParams.set('tab', id);
  window.history.pushState({}, '', url);
  renderDashboard();
}

/** Apply the configured background colour for the current theme (light/dark) */
function applyBodyBg() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const color = isDark ? (window._bgDark || '') : (window._bgLight || '');
  document.body.style.backgroundColor = color || '';
}

function applyBranding(cfg) {
  const titleEl = document.getElementById('dashboard-title');
  const logoEl = document.getElementById('logo-img');
  const title = cfg.dashboard_title || 'Epilykos';
  titleEl.textContent = title;
  document.title = title;
  if (cfg.dashboard_logo) { logoEl.src = cfg.dashboard_logo; logoEl.style.display = 'inline'; }
  else { logoEl.style.display = 'none'; }
  if (cfg.dashboard_favicon) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = cfg.dashboard_favicon;
  }
  window.systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
  document.body.classList.toggle('transparent-blocks', cfg.transparent_blocks === 'true');
  // Store bg colors for theme-aware application
  window._bgLight = cfg.dashboard_bg_color_light || cfg.dashboard_bg_color || '#f8fafc';
  window._bgDark = cfg.dashboard_bg_color_dark || '#0f172a';
  applyBodyBg();
  document.body.addEventListener('theme-changed', applyBodyBg);
  if (cfg.dashboard_bg_image) { document.body.style.backgroundImage = `url(${cfg.dashboard_bg_image})`; document.body.style.backgroundSize = 'cover'; document.body.style.backgroundPosition = 'center'; document.body.style.backgroundAttachment = 'fixed'; }
}

export { dashboardConfig, renderDashboard, switchDashboard };
