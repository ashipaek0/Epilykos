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
import { applyFavicon } from './favicon.js';
import { fetchDashboardConfig, saveDashboardConfig, fetchPublicConfig } from './api.js';
import { getBuilder } from './components/index.js';
import { destroyCharts, initPowerChart, initEnergyChart, initMetricChart } from './charts.js';
import { updateDailyTable, updateMonthlyTable } from './tables.js';
import { clearSparklineCharts } from './forecast.js';
import { updateAllComponents, updateWithState } from './updater.js';
import { markFresh } from './updated-age.js';
import { ensureBlockIds } from './utils/blockId.js';
import { ensureChartJS } from './chartLoader.js';
import { applyBlockStyle } from './components/blockStyle.js';
import { globalAppearance, effectiveAppearance, applyAppearance } from './appearance.js';
import { gridOf, placeBlocks, blockStyle, areaHeight, SCALE_REFERENCE_WIDTH } from './layoutGrid.js';
import { tabsFor, effectivePosition, readCollapsed, writeCollapsed } from './dashboard-tabs.js';
import { initNotificationBell } from './notification-bell.js';

let dashboardConfig;
let signedIn = false;     // the visitor has a session: Controls, Edit layout and the header links show
let tabsSetting = 'top';  // Settings → Appearance: where the dashboard tabs sit
let defaultLook = null;   // Settings → Appearance: the look of every dashboard that does not override it

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
  // Set initial theme based on active dashboard
  const activeDash = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard);
  if (activeDash && activeDash.name === 'Light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (activeDash && activeDash.name === 'Default') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  defaultLook = globalAppearance(cfg);
  tabsSetting = cfg.tabs_position;
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
  applyDashboardLook();
  destroyCharts();
  clearSparklineCharts();

  renderTabs();

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

  // Render blocks with absolute positioning based on GridStack coordinates (public/js/layoutGrid.js)
  const grid = gridOf(active);

  const positioned = [];
  layoutWithIds.forEach((block) => {
    if (block.enabled === false) return;
    const builder = getBuilder(block.type);
    if (!builder) return;
    positioned.push({ block, x: block.gridX ?? 0, y: block.gridY ?? 0, w: block.gridW ?? grid.columns, h: block.gridH ?? 4 });
  });
  const placed = placeBlocks(positioned, grid);

  const rendered = [];   // the area is as tall as what was drawn
  placed.forEach(item => {
    const block = item.block;
    let content;
    try {
      content = getBuilder(block.type)(block);
    } catch (e) {
      console.error('Block render failed:', block.type, block.id, e);
      content = document.createElement('div');
      content.className = 'dashboard-block block-error';
      content.textContent = '⚠️ Block render error';
    }
    if (!content) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'dashboard-block';
    wrapper.dataset.blockId = block.id;
    wrapper.style.position = 'absolute';
    Object.assign(wrapper.style, blockStyle(item, grid));

    applyBlockStyle(content, block);
    wrapper.appendChild(content);
    container.appendChild(wrapper);
    rendered.push(item);
  });

  container.style.position = 'relative';
  if (grid.scale) {
    // Scaled to the screen width: the area's height, like every px length in it, is its width's share of
    // SCALE_REFERENCE_WIDTH times the stated size (style.css), so it follows the window without being redrawn.
    container.style.height = '';
    container.style.setProperty('--extent', String(areaHeight(rendered, grid)));
    trackScale(container);
  } else {
    container.style.height = areaHeight(rendered, grid) + 'px';
    container.style.removeProperty('--extent');
    untrackScale(container);
  }
  container.classList.toggle('is-scaled', !!grid.scale);

  // Auth-dependent UI: sign-in/out, Controls and the editor link
  checkSession();

  // First-run setup detection: show banner + auto-open the wizard once per browser session
  fetch('/api/wizard/status')
    .then(r => r.json())
    .then(w => {
      const banner = document.getElementById('setup-banner');
      if (w && !w.hasDataSource) {
        if (banner) banner.style.display = '';
        if (w.needsSetup && !sessionStorage.getItem('epilykos_wizard_opened')) {
          sessionStorage.setItem('epilykos_wizard_opened', '1');
          window.location.href = '/setup';
        }
      } else if (banner) {
        banner.style.display = 'none';
      }
    }).catch(() => {});
  const bannerDismiss = document.getElementById('setup-banner-dismiss');
  if (bannerDismiss) {
    bannerDismiss.addEventListener('click', () => {
      const b = document.getElementById('setup-banner');
      if (b) b.style.display = 'none';
    });
  }

  const hasPower = active.layout.some(b => b.type === 'chart-power');
  const hasEnergy = active.layout.some(b => b.type === 'chart-energy');
  const hasMetric = active.layout.some(b => b.type === 'chart-metric');
  if (hasPower || hasEnergy || hasMetric) {
    ensureChartJS().then(() => {
      if (hasPower) initPowerChart();
      if (hasEnergy) initEnergyChart();
      if (hasMetric) initMetricChart();
    }).catch(e => console.error('Chart.js load failed:', e));
  }

  // Defer data fetches — WebSocket pushes initial state; tables and forecast load staggered
  setTimeout(() => {
    updateDailyTable().catch(e => console.error('Daily table error:', e));
    updateMonthlyTable().catch(e => console.error('Monthly table error:', e));
  }, 2000);
  // updateAllComponents() is called by main.js after WebSocket connects
}

/**
 * The tab bar. Everyone gets the dashboards' tabs (when there is more than one); a signed-in session also gets
 * Controls and Edit layout. It sits along the top or down a side (Settings → Appearance), phones always top,
 * and the ☰ button in the header folds it away; that choice is kept in this browser.
 */
function renderTabs() {
  const header = document.querySelector('header');
  const container = document.getElementById('dashboard-container');
  if (!header || !container) return;

  // One shell holds the bar and the cards, so a side bar can sit beside them.
  let shell = document.getElementById('dash-shell');
  if (!shell) {
    shell = document.createElement('div');
    shell.id = 'dash-shell';
    container.before(shell);
    shell.appendChild(container);
  }
  let tabBar = document.getElementById('tab-bar');
  if (!tabBar) {
    tabBar = document.createElement('nav');
    tabBar.id = 'tab-bar';
    tabBar.setAttribute('aria-label', 'Dashboards');
    shell.prepend(tabBar);
  }

  const { tabs, show } = tabsFor(dashboardConfig.dashboards, signedIn);
  const position = effectivePosition(tabsSetting, window.innerWidth);
  shell.dataset.tabs = position;

  let toggle = document.getElementById('tab-toggle');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.id = 'tab-toggle';
    toggle.type = 'button';
    toggle.className = 'settings-link';
    toggle.textContent = '☰';
    toggle.onclick = () => {
      writeCollapsed(!readCollapsed());
      renderTabs();
    };
    (document.querySelector('header .header-right') || header).appendChild(toggle);
  }
  const collapsed = readCollapsed();
  toggle.style.display = show ? '' : 'none';
  toggle.title = collapsed ? 'Show dashboard tabs' : 'Hide dashboard tabs';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  tabBar.hidden = !show || collapsed;

  tabBar.innerHTML = '';
  tabs.forEach(t => {
    if (t.kind === 'page') {
      const a = document.createElement('a');
      a.className = 'dashboard-tab dashboard-tab-page';
      a.href = t.href;
      a.textContent = t.label;
      tabBar.appendChild(a);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dashboard-tab' + (t.id === dashboardConfig.activeDashboard ? ' active' : '');
    if (t.id === dashboardConfig.activeDashboard) b.setAttribute('aria-current', 'page');
    b.textContent = t.label;
    b.onclick = () => switchDashboard(t.id);
    tabBar.appendChild(b);
  });
  if (signedIn) {
    const edit = document.createElement('a');
    edit.className = 'dashboard-tab dashboard-tab-page';
    edit.textContent = 'Edit layout';
    edit.href = `/editor?tab=${encodeURIComponent(dashboardConfig.activeDashboard)}`;
    // Tabs switch without a reload, so point at the tab shown at click time.
    edit.addEventListener('click', () => { edit.href = `/editor?tab=${encodeURIComponent(dashboardConfig.activeDashboard)}`; });
    tabBar.appendChild(edit);
  }
}

let sessionChecked = false;
/** Asks once whether there is a session; then draws what only a signed-in session sees. */
function checkSession() {
  if (sessionChecked) return;
  sessionChecked = true;
  fetch('/api/auth/status')
    .then(r => r.json())
    .then(auth => {
      if (!auth.authenticated) return;
      signedIn = true;
      const pageHeader = document.querySelector('.container > header');
      if (pageHeader) pageHeader.classList.add('is-signed-in');
      const signoutBtn = document.getElementById('signout-btn');
      const settingsBtn = document.getElementById('settings-btn');
      if (signoutBtn) {
        signoutBtn.style.display = '';
        // A POST, so another site cannot sign anyone out with a link.
        signoutBtn.addEventListener('click', (event) => {
          event.preventDefault();
          fetch('/api/logout', { method: 'POST' }).catch(() => {}).finally(() => { window.location.href = '/'; });
        });
      }
      if (settingsBtn) settingsBtn.style.display = '';
      // Signed-in pages: added only for a signed-in session (the server refuses them otherwise).
      // Controls is not here: it is a tab beside the dashboards, for a signed-in session only.
      if (settingsBtn && !document.getElementById('showcase-link')) {
        const a = document.createElement('a');
        a.id = 'showcase-link'; a.href = '/showcase'; a.className = 'settings-link'; a.textContent = 'Card showcase';
        settingsBtn.before(a);
      }
      // The notification bell: recent alerts, signed-in admins only.
      initNotificationBell(document.querySelector('header .header-right'), signoutBtn || undefined);
      const themeToggle = document.getElementById('theme-toggle');
      if (themeToggle) themeToggle.style.display = '';
      renderTabs();
    }).catch(() => { sessionChecked = false; });
}

window.addEventListener('resize', () => { if (dashboardConfig && dashboardConfig.dashboards) renderTabs(); });
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(window.location.search).get('tab');
  if (dashboardConfig && id && id !== dashboardConfig.activeDashboard && dashboardConfig.dashboards.some(db => db.id === id)) {
    dashboardConfig.activeDashboard = id;
    renderDashboard();
  }
});

async function switchDashboard(id) {
  dashboardConfig.activeDashboard = id;
  // Only a signed-in session may save; a visitor just looks at the other dashboard.
  if (signedIn) await saveDashboardConfig(dashboardConfig).catch(e => console.warn('Could not save the shown dashboard:', e));
  const url = new URL(window.location);
  url.searchParams.set('tab', id);
  window.history.pushState({}, '', url);
  // Auto-switch theme: "Light" dashboard → light mode, others → dark mode
  const dash = dashboardConfig.dashboards.find(db => db.id === id);
  if (dash && dash.name === 'Light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (dash && dash.name === 'Default') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  renderDashboard();
}

/**
 * The active dashboard's look: the defaults from Settings → Appearance with the dashboard's own
 * overrides on top (public/js/appearance.js). Applied on every render, so switching dashboards
 * changes the background and blocks too.
 */
function applyDashboardLook() {
  if (!defaultLook) return;
  const active = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard);
  // A dashboard that scales to the screen width has its picture on the layout area, so a block sits on the same
  // part of it on any screen; the page keeps it too, for phones, where the blocks stack (style.css hides it elsewhere).
  const scaled = !!(active && gridOf(active).scale);
  const area = document.getElementById('dashboard-container');
  document.body.classList.toggle('scale-layout', scaled);
  applyAppearance(effectiveAppearance(defaultLook, active && active.appearance), { anchored: scaled && area ? { el: area, fallback: true } : null });
}

// The area's width over SCALE_REFERENCE_WIDTH, as --s on the area, for a dashboard that scales to the screen width.
let scaleObserver = null;
function trackScale(area) {
  const set = () => area.style.setProperty('--s', String(Math.round((area.clientWidth / SCALE_REFERENCE_WIDTH) * 1000) / 1000));
  set();
  if (typeof ResizeObserver !== 'function') { window.addEventListener('resize', set); return; }
  if (!scaleObserver) scaleObserver = new ResizeObserver(entries => entries.forEach(e => e.target.style.setProperty('--s', String(Math.round((e.contentRect.width / SCALE_REFERENCE_WIDTH) * 1000) / 1000))));
  scaleObserver.observe(area);
}
function untrackScale(area) {
  if (scaleObserver) scaleObserver.unobserve(area);
  area.style.removeProperty('--s');
}

function applyBranding(cfg) {
  const titleEl = document.getElementById('dashboard-title');
  const logoEl = document.getElementById('logo-img');
  const title = cfg.dashboard_title || 'Epilykos';
  titleEl.textContent = title;
  document.title = title;
  if (cfg.dashboard_logo) { logoEl.src = cfg.dashboard_logo; logoEl.style.display = 'inline'; }
  else { logoEl.src = '/icons/epilykos-mark.svg'; logoEl.style.display = 'inline'; }
  applyFavicon(document, cfg.dashboard_favicon);
  window.systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
}

export { dashboardConfig, renderDashboard, switchDashboard };

// Partial-render listener (Phase 2 delta compression): ws-manager dispatches
// 'state-updated' with detail { isPartial: true, state, keys } when a
// dashboard-delta arrives. When every delta key is a known top-level state
// key (see buildDashboardState() in routes/metrics.js), update only the DOM
// via the existing card updater fns — no full re-render. Unknown keys, or a
// non-partial event (isPartial false/undefined), fall back to renderDashboard().
const PARTIAL_RENDER_KEYS = new Set([
  'current', 'metrics', 'savings', 'gridStatus',
  'gridHours', 'gridTimeline', 'gridDaily', 'gridCost',
  'generatorStatus', 'generatorHours', 'generatorTimeline', 'generatorDaily', 'generatorCost', 'powerHistory', 'dailyEnergyBar', 'breakdowns', 'solarToday',
]);
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('state-updated', (event) => {
    const detail = event && event.detail;
    markFresh();
    if (!detail || !detail.isPartial) {
      renderDashboard();
      return;
    }
    const state = detail.state;
    const keys = Array.isArray(detail.keys) ? detail.keys : Object.keys(state || {});
    if (state && keys.length > 0 && keys.every((k) => PARTIAL_RENDER_KEYS.has(k))) {
      updateWithState(state);
    } else {
      renderDashboard();
    }
  });
}
