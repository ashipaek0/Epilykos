import { fetchDashboardConfig, saveDashboardConfig } from './api.js';
import { componentBuilders } from './components/index.js';

let grid = null, dashboardConfig = null, currentTabId = null, unsaved = false;

function markUnsaved() { unsaved = true; document.getElementById('unsaved-indicator').classList.add('show'); }
function clearUnsaved() { unsaved = false; document.getElementById('unsaved-indicator').classList.remove('show'); }
function showLoading(msg) { let o = document.getElementById('loading-overlay'); if (!o) { o = document.createElement('div'); o.id = 'loading-overlay'; o.className = 'loading-overlay'; o.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p id="loading-message"></p></div>'; document.body.appendChild(o); } document.getElementById('loading-message').textContent = msg; o.style.display = 'flex'; }
function hideLoading() { const o = document.getElementById('loading-overlay'); if (o) o.style.display = 'none'; }

async function persistLayout() {
  if (!grid) return;
  var items = grid.getGridItems();
  var layout = [];
  items.forEach(function(el) {
    var n = el.gridstackNode;
    var block = { id: el.dataset.blockId, type: el.dataset.blockType, gridX: n.x, gridY: n.y, gridW: n.w, gridH: n.h, enabled: true, config: {} };
    var existing = null;
    var tabs = dashboardConfig.dashboards;
    for (var ti = 0; ti < tabs.length; ti++) {
      if (tabs[ti].id === currentTabId) {
        for (var li = 0; li < tabs[ti].layout.length; li++) {
          if (tabs[ti].layout[li].id === el.dataset.blockId) { existing = tabs[ti].layout[li]; break; }
        }
        break;
      }
    }
    if (existing) { block.config = existing.config; block.transparent = existing.transparent; block.bgColor = existing.bgColor; block.fontColor = existing.fontColor; block.fontSize = existing.fontSize; if (existing.metrics) block.metrics = existing.metrics; if (existing.cards) block.cards = existing.cards; if (existing.columns) block.columns = existing.columns; }
    layout.push(block);
  });
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; });
  if (tab) { tab.layout = layout; tab.name = document.getElementById('dash-name-input').value || tab.name; }
  await saveDashboardConfig(dashboardConfig).catch(function(e) { console.warn('Save failed:', e); });
}

function refreshTabSelect() {
  var ts = document.getElementById('tab-select');
  ts.innerHTML = '';
  dashboardConfig.dashboards.forEach(function(db) {
    var o = document.createElement('option'); o.value = db.id; o.textContent = db.name; o.selected = db.id === currentTabId;
    ts.appendChild(o);
  });
}

/**
 * Build a single grid-stack-item DOM element for a block definition.
 * @param {object} block - block config {id, type, gridX, gridY, gridW, gridH, ...}
 * @returns {HTMLElement} the grid-stack-item element
 */
function buildGridItem(block) {
  var builder = componentBuilders[block.type];
  if (!builder) return null;
  var content = builder(block);
  if (!content) return null;

  var item = document.createElement('div');
  item.className = 'grid-stack-item';
  item.dataset.blockId = block.id || ('b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6));
  item.dataset.blockType = block.type;
  item.setAttribute('gs-x', block.gridX ?? 0);
  item.setAttribute('gs-y', block.gridY ?? 0);
  item.setAttribute('gs-w', block.gridW ?? block.colSpan ?? 6);
  item.setAttribute('gs-h', block.gridH ?? Math.max(1, Math.round((block.rowSpan ?? 200) / 50)));
  item.setAttribute('gs-min-w', 2);
  item.setAttribute('gs-min-h', 1);

  var inner = document.createElement('div');
  inner.className = 'grid-stack-item-content';
  inner.style.padding = '0.5rem'; inner.style.fontSize = '0.8rem'; inner.style.position = 'relative';

  var delBtn = document.createElement('button');
  delBtn.textContent = '\u2715';
  delBtn.style.cssText = 'position:absolute;top:4px;right:4px;z-index:10;background:#ef4444;color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:12px;line-height:1;';
  delBtn.addEventListener('click', function(e) { e.stopPropagation(); grid.removeWidget(item); persistLayout(); markUnsaved(); });
  inner.appendChild(delBtn);
  inner.appendChild(content);
  item.appendChild(inner);
  return item;
}

/**
 * Add a single block to the active dashboard without rebuilding the entire grid.
 * @param {string} type - block type identifier
 */
function addBlockToGrid(type) {
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; });
  if (!tab) return;
  var newBlock = { id: 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), type: type, enabled: true, colSpan: 6, rowSpan: 200, config: {} };
  tab.layout.push(newBlock);
  var item = buildGridItem(newBlock);
  if (!item) return;

  // Add via GridStack API — finds next available Y position
  grid.addWidget(item);
  markUnsaved();
  persistLayout(); // auto-save after add
}

async function loadTab(tabId) {
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === tabId; });
  if (!tab) return;
  currentTabId = tabId;
  document.getElementById('dash-name-input').value = tab.name || '';
  refreshTabSelect();

  var container = document.getElementById('grid');
  container.innerHTML = '';
  if (grid) { grid.destroy(false); grid = null; }

  tab.layout.forEach(function(block) {
    if (block.enabled === false) return;
    var item = buildGridItem(block);
    if (item) container.appendChild(item);
  });

  grid = GridStack.init({ column: 12, cellHeight: 50, float: false, animate: true, resizable: { handles: 'e, se, s, sw, w' }, minRow: 1 }, container);
  grid.on('change', function() { markUnsaved(); });
  grid.on('dragstop', function() { persistLayout(); });
  grid.on('resizestop', function() { persistLayout(); });

  // Enable palette drops via GridStack's own drop handling
  grid.opts.acceptWidgets = function(el) { return true; };

  var dropZone = container.closest('.editor-grid-wrapper') || container;
  dropZone.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  dropZone.addEventListener('drop', function(e) {
    e.preventDefault();
    var type = e.dataTransfer.getData('blockType');
    if (type) addBlockToGrid(type);
  });

  // Auth check for header buttons
  fetch('/api/auth/status')
    .then(function(r) { return r.json(); })
    .then(function(auth) {
      if (!auth.authenticated) {
        document.getElementById('save-btn').disabled = true;
        dropZone.style.opacity = '0.5';
        dropZone.style.pointerEvents = 'none';
      }
    }).catch(function() {});
}

async function initEditor() {
  showLoading('Loading editor...');
  try {
    dashboardConfig = await fetchDashboardConfig();
    if (!dashboardConfig.dashboards || !dashboardConfig.dashboards.length) {
      dashboardConfig.dashboards = [{ id: 'main', name: 'Main', layout: [] }];
      dashboardConfig.activeDashboard = 'main';
    }
    currentTabId = dashboardConfig.activeDashboard || dashboardConfig.dashboards[0].id;

    refreshTabSelect();
    document.getElementById('tab-select').addEventListener('change', function(e) {
      if (unsaved) { persistLayout(); clearUnsaved(); }
      loadTab(e.target.value);
    });
    document.getElementById('dash-name-input').addEventListener('change', function() { markUnsaved(); });

    // New Dashboard
    document.getElementById('new-dash-btn').addEventListener('click', function() {
      var id = 'db_' + Date.now();
      dashboardConfig.dashboards.push({ id: id, name: 'New Dashboard', layout: [] });
      dashboardConfig.activeDashboard = id;
      persistLayout(); clearUnsaved();
      loadTab(id);
    });

    // Delete Dashboard
    document.getElementById('delete-dash-btn').addEventListener('click', function() {
      if (dashboardConfig.dashboards.length <= 1) { alert('Cannot delete the last dashboard.'); return; }
      if (!confirm('Delete this dashboard and all its blocks?')) return;
      dashboardConfig.dashboards = dashboardConfig.dashboards.filter(function(db) { return db.id !== currentTabId; });
      currentTabId = dashboardConfig.dashboards[0].id;
      dashboardConfig.activeDashboard = currentTabId;
      saveDashboardConfig(dashboardConfig).catch(function(e) { console.warn(e); });
      loadTab(currentTabId);
    });

    // Palette — use addBlockToGrid instead of loadTab rebuild
    var palette = document.getElementById('available-blocks');
    var names = { 'flow-card':'\uD83D\uDD04 Flow Card','forecast-banner':'\u2600\uFE0F Forecast','metric-cards':'\uD83D\uDCCA Metric Cards','grid-card':'\uD83D\uDD0C Grid Card','chart-power':'\u26A1 Power Chart','chart-energy':'\uD83D\uDCC8 Energy Chart','savings-summary':'\uD83D\uDCB0 Savings','data-table-daily':'\uD83D\uDCCB Daily Table','data-table-monthly':'\uD83D\uDCC5 Monthly Table','weather-block':'\uD83C\uDF26\uFE0F Weather','battery-block':'\uD83D\uDD0B Battery','flow-card-2':'\uD83D\uDD04 Flow Card 2','multi-value':'\uD83D\uDCCA Multi-Value','gauge-card':'\uD83C\uDFAF Gauge','text-card':'\uD83D\uDCDD Text','iframe-card':'\uD83C\uDF10 Embed' };
    Object.entries(componentBuilders).forEach(function(entry) {
      var type = entry[0];
      var item = document.createElement('div');
      item.className = 'block-item'; item.textContent = names[type] || type; item.draggable = true; item.dataset.blockType = type;
      item.addEventListener('dragstart', function(e) { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('blockType', type); });
      item.addEventListener('click', function() { addBlockToGrid(type); });
      palette.appendChild(item);
    });

    // Export/Import
    document.getElementById('export-btn').addEventListener('click', function() {
      var json = JSON.stringify(dashboardConfig, null, 2);
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'dashboard-config.json'; a.click();
    });
    document.getElementById('import-btn').addEventListener('click', function() {
      var input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
      input.addEventListener('change', async function(e) {
        var file = e.target.files[0]; if (!file) return;
        try {
          var text = await file.text(); var imported = JSON.parse(text);
          if (!imported.dashboards) throw new Error('Invalid format');
          dashboardConfig = imported;
          currentTabId = dashboardConfig.dashboards[0]?.id;
          if (currentTabId) loadTab(currentTabId);
          refreshTabSelect();
          markUnsaved();
        } catch (err) { alert('Import failed: ' + err.message); }
      });
      input.click();
    });

    await loadTab(currentTabId);
    document.getElementById('save-btn').addEventListener('click', async function() { await persistLayout(); clearUnsaved(); var validTab = dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; }) ? currentTabId : dashboardConfig.dashboards[0]?.id || 'main'; window.location.href = '/?tab=' + encodeURIComponent(validTab); });
    hideLoading();
  } catch (e) { hideLoading(); alert('Editor failed: ' + e.message); }
}

initEditor();
