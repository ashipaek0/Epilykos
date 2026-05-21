import { fetchDashboardConfig, saveDashboardConfig } from './api.js';
import { componentBuilders } from './components/index.js';

let grid = null, dashboardConfig = null, currentTabId = null, unsaved = false;

function markUnsaved() { unsaved = true; document.getElementById('unsaved-indicator').classList.add('show'); }
function clearUnsaved() { unsaved = false; document.getElementById('unsaved-indicator').classList.remove('show'); }
function showLoading(msg) { let o = document.getElementById('loading-overlay'); if (!o) { o = document.createElement('div'); o.id = 'loading-overlay'; o.className = 'loading-overlay'; o.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p id="loading-message"></p></div>'; document.body.appendChild(o); } document.getElementById('loading-message').textContent = msg; o.style.display = 'flex'; }
function hideLoading() { const o = document.getElementById('loading-overlay'); if (o) o.style.display = 'none'; }

async function persistLayout() {
  if (!grid) return;
  const items = grid.getGridItems();
  const layout = [];
  items.forEach(el => {
    const n = el.gridstackNode;
    const block = { id: el.dataset.blockId, type: el.dataset.blockType, gridX: n.x, gridY: n.y, gridW: n.w, gridH: n.h, enabled: true, config: {} };
    const existing = dashboardConfig.dashboards.find(db => db.id === currentTabId)?.layout.find(b => b.id === el.dataset.blockId);
    if (existing) { block.config = existing.config; block.transparent = existing.transparent; block.bgColor = existing.bgColor; block.fontColor = existing.fontColor; block.fontSize = existing.fontSize; if (existing.metrics) block.metrics = existing.metrics; if (existing.cards) block.cards = existing.cards; if (existing.columns) block.columns = existing.columns; }
    layout.push(block);
  });
  const tab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
  if (tab) { tab.layout = layout; tab.name = document.getElementById('dash-name-input').value || tab.name; }
  await saveDashboardConfig(dashboardConfig).catch(e => console.warn('Save failed:', e));
}

function refreshTabSelect() {
  const ts = document.getElementById('tab-select');
  ts.innerHTML = '';
  dashboardConfig.dashboards.forEach(db => {
    const o = document.createElement('option'); o.value = db.id; o.textContent = db.name; o.selected = db.id === currentTabId;
    ts.appendChild(o);
  });
}

async function loadTab(tabId) {
  const tab = dashboardConfig.dashboards.find(db => db.id === tabId);
  if (!tab) return;
  currentTabId = tabId;
  document.getElementById('dash-name-input').value = tab.name || '';
  refreshTabSelect();

  const container = document.getElementById('grid');
  container.innerHTML = '';
  if (grid) { grid.destroy(false); grid = null; }

  tab.layout.forEach(block => {
    if (block.enabled === false) return;
    const builder = componentBuilders[block.type];
    if (!builder) return;
    const content = builder(block);
    if (!content) return;

    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.dataset.blockId = block.id || ('b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6));
    item.dataset.blockType = block.type;
    item.setAttribute('gs-x', block.gridX ?? 0);
    item.setAttribute('gs-y', block.gridY ?? 0);
    item.setAttribute('gs-w', block.gridW ?? block.colSpan ?? 6);
    item.setAttribute('gs-h', block.gridH ?? Math.max(1, Math.round((block.rowSpan ?? 200) / 50)));
    item.setAttribute('gs-min-w', 2);
    item.setAttribute('gs-min-h', 1);

    const inner = document.createElement('div');
    inner.className = 'grid-stack-item-content';
    inner.style.padding = '0.5rem'; inner.style.fontSize = '0.8rem'; inner.style.position = 'relative';

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.style.cssText = 'position:absolute;top:4px;right:4px;z-index:10;background:#ef4444;color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:12px;line-height:1;';
    delBtn.addEventListener('click', e => { e.stopPropagation(); grid.removeWidget(item); persistLayout(); markUnsaved(); });
    inner.appendChild(delBtn);
    inner.appendChild(content);
    item.appendChild(inner);
    container.appendChild(item);
  });

  grid = GridStack.init({ column: 12, cellHeight: 50, float: false, animate: true, resizable: { handles: 'e, se, s, sw, w' }, minRow: 1 }, container);
  grid.on('change', () => { markUnsaved(); });
  grid.on('dragstop', () => { persistLayout(); });
  grid.on('resizestop', () => { persistLayout(); });

  // Enable palette drops via GridStack's own drop handling
  grid.opts.acceptWidgets = (el) => true;
  const dropZone = container.closest('.editor-grid-wrapper') || container;
  dropZone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    const type = e.dataTransfer.getData('blockType');
    if (!type) return;
    const tab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
    if (!tab) return;
    const newBlock = { id: 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), type, enabled: true, colSpan: 6, rowSpan: 200, config: {} };
    tab.layout.push(newBlock);
    loadTab(currentTabId).then(() => { persistLayout(); markUnsaved(); });
  });
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
    document.getElementById('tab-select').addEventListener('change', e => {
      if (unsaved) { persistLayout(); clearUnsaved(); }
      loadTab(e.target.value);
    });
    document.getElementById('dash-name-input').addEventListener('change', () => { markUnsaved(); });

    // New Dashboard
    document.getElementById('new-dash-btn').addEventListener('click', () => {
      const id = 'db_' + Date.now();
      dashboardConfig.dashboards.push({ id, name: 'New Dashboard', layout: [] });
      dashboardConfig.activeDashboard = id;
      persistLayout(); clearUnsaved();
      loadTab(id);
    });

    // Delete Dashboard
    document.getElementById('delete-dash-btn').addEventListener('click', () => {
      if (dashboardConfig.dashboards.length <= 1) { alert('Cannot delete the last dashboard.'); return; }
      if (!confirm('Delete this dashboard and all its blocks?')) return;
      dashboardConfig.dashboards = dashboardConfig.dashboards.filter(db => db.id !== currentTabId);
      currentTabId = dashboardConfig.dashboards[0].id;
      dashboardConfig.activeDashboard = currentTabId;
      saveDashboardConfig(dashboardConfig).catch(e => console.warn(e));
      loadTab(currentTabId);
    });

    // Palette
    const palette = document.getElementById('available-blocks');
    const names = { 'flow-card':'🔄 Flow Card','forecast-banner':'☀️ Forecast','metric-cards':'📊 Metric Cards','grid-card':'🔌 Grid Card','chart-power':'⚡ Power Chart','chart-energy':'📈 Energy Chart','savings-summary':'💰 Savings','data-table-daily':'📋 Daily Table','data-table-monthly':'📅 Monthly Table','weather-block':'🌤️ Weather','battery-block':'🔋 Battery','flow-card-2':'🔄 Flow Card 2','multi-value':'📊 Multi-Value','gauge-card':'🎯 Gauge','text-card':'📝 Text','iframe-card':'🌐 Embed' };
    Object.entries(componentBuilders).forEach(([type]) => {
      const item = document.createElement('div');
      item.className = 'block-item'; item.textContent = names[type] || type; item.draggable = true; item.dataset.blockType = type;
      item.addEventListener('dragstart', e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('blockType', type); });
      item.addEventListener('click', () => {
        const tab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
        if (!tab) return;
        tab.layout.push({ id: 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), type, enabled: true, colSpan: 6, rowSpan: 200, config: {} });
        loadTab(currentTabId).then(() => { persistLayout(); markUnsaved(); });
      });
      palette.appendChild(item);
    });

    // Export/Import
    document.getElementById('export-btn').addEventListener('click', () => {
      const json = JSON.stringify(dashboardConfig, null, 2);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'dashboard-config.json'; a.click();
    });
    document.getElementById('import-btn').addEventListener('click', () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
      input.addEventListener('change', async e => {
        const file = e.target.files[0]; if (!file) return;
        try {
          const text = await file.text(); const imported = JSON.parse(text);
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
    document.getElementById('save-btn').addEventListener('click', async () => { await persistLayout(); clearUnsaved(); const validTab = dashboardConfig.dashboards.find(db => db.id === currentTabId) ? currentTabId : dashboardConfig.dashboards[0]?.id || 'main'; window.location.href = '/?tab=' + encodeURIComponent(validTab); });
    hideLoading();
  } catch (e) { hideLoading(); alert('Editor failed: ' + e.message); }
}

initEditor();
