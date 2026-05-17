import { fetchDashboardConfig, saveDashboardConfig } from './api.js';
import { componentBuilders } from './components/index.js';
import { generateBlockId, ensureBlockIds } from './utils/blockId.js';

let gridstack = null;
let dashboardConfig = null;
let currentTabId = null;
let unsavedChanges = false;

// Undo/redo – stores layout snapshots (only current tab)
let history = [];
let historyIndex = -1;
const HISTORY_LIMIT = 15;

// Debounce timer for saveState
let saveStateTimeout = null;

// Block constraints (min/max width/height)
const BLOCK_CONSTRAINTS = {
  'flow-card': { minW: 12, minH: 3, maxW: 12 },
  'chart-power': { minW: 4, minH: 3 },
  'chart-energy': { minW: 4, minH: 3 },
  'grid-card': { minW: 8, minH: 3 },
  'metric-cards': { minW: 3, minH: 2 },
  'forecast-banner': { minW: 12, minH: 4, maxW: 12 },
  'data-table-daily': { minW: 6, minH: 4 },
  'data-table-monthly': { minW: 6, minH: 4 },
  'savings-summary': { minW: 6, minH: 3 },
  'weather-block': { minW: 4, minH: 3 },
  'battery-block': { minW: 4, minH: 3 }
};

// Helper functions
function showLoading(message = 'Loading...') {
  let overlay = document.getElementById('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `
      <div class="loading-spinner">
        <div class="spinner"></div>
        <p id="loading-message">${message}</p>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  document.getElementById('loading-message').textContent = message;
  overlay.style.display = 'flex';
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.style.display = 'none';
}

function markUnsaved() {
  unsavedChanges = true;
  const indicator = document.getElementById('unsaved-indicator');
  if (indicator) indicator.classList.add('show');
}

function clearUnsaved() {
  unsavedChanges = false;
  const indicator = document.getElementById('unsaved-indicator');
  if (indicator) indicator.classList.remove('show');
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
}

// Save current tab's layout to history (differential)
function saveState() {
  const activeTab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
  if (!activeTab) return;

  // Sync grid positions to config first
  syncGridToConfig();

  const layoutSnapshot = JSON.stringify(activeTab.layout);
  // Trim forward history
  history = history.slice(0, historyIndex + 1);
  // Avoid duplicate consecutive snapshots
  if (historyIndex >= 0 && history[historyIndex] === layoutSnapshot) return;

  history.push(layoutSnapshot);
  historyIndex++;
  if (history.length > HISTORY_LIMIT) {
    history.shift();
    historyIndex--;
  }
  updateHistoryButtons();
}

function restoreSnapshot() {
  if (historyIndex < 0 || !history[historyIndex]) return;
  const activeTab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
  if (!activeTab) return;
  try {
    activeTab.layout = JSON.parse(history[historyIndex]);
    loadTab(currentTabId);
    markUnsaved();
  } catch (err) {
    console.error('Restore failed:', err);
  }
}

function undo() {
  if (historyIndex > 0) {
    historyIndex--;
    restoreSnapshot();
  }
}

function redo() {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    restoreSnapshot();
  }
}

// Sync current grid positions back to config (using block IDs)
function syncGridToConfig() {
  const activeTab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
  if (!activeTab || !gridstack) return;

  const items = gridstack.getGridItems();
  const orderedItems = Array.from(items).sort((a, b) => {
    const aY = a.gridstackNode.y;
    const bY = b.gridstackNode.y;
    if (aY !== bY) return aY - bY;
    return a.gridstackNode.x - b.gridstackNode.x;
  });

  const newLayout = [];
  orderedItems.forEach(el => {
    const blockId = el.dataset.blockId;
    const block = activeTab.layout.find(b => b.id === blockId);
    if (block) {
      block.gridX = el.gridstackNode.x;
      block.gridY = el.gridstackNode.y;
      block.gridW = el.gridstackNode.w;
      block.gridH = el.gridstackNode.h;
      newLayout.push(block);
    }
  });
  activeTab.layout = newLayout;
}

// Debounced saveState
function debouncedSaveState() {
  if (saveStateTimeout) clearTimeout(saveStateTimeout);
  saveStateTimeout = setTimeout(() => {
    syncGridToConfig();
    saveState();
  }, 300);
}

// Build a grid item DOM element (without attaching to grid)
function buildGridItem(block) {
  const gridItem = document.createElement('div');
  gridItem.className = 'grid-stack-item';
  gridItem.setAttribute('gs-x', block.gridX ?? 0);
  gridItem.setAttribute('gs-y', block.gridY ?? 0);
  gridItem.setAttribute('gs-w', block.gridW ?? 6);
  gridItem.setAttribute('gs-h', block.gridH ?? 4);
  gridItem.setAttribute('gs-min-w', BLOCK_CONSTRAINTS[block.type]?.minW ?? 2);
  gridItem.setAttribute('gs-min-h', BLOCK_CONSTRAINTS[block.type]?.minH ?? 2);
  if (BLOCK_CONSTRAINTS[block.type]?.maxW) {
    gridItem.setAttribute('gs-max-w', BLOCK_CONSTRAINTS[block.type].maxW);
  }
  gridItem.dataset.blockId = block.id;

  const content = document.createElement('div');
  content.className = 'grid-stack-item-content';

  // Header with label, settings, delete
  const header = document.createElement('div');
  header.className = 'grid-item-header';

  const label = document.createElement('span');
  label.className = 'grid-item-label';
  label.textContent = block.type;

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'grid-item-settings';
  settingsBtn.textContent = '⚙️';
  settingsBtn.title = 'Edit block settings';
  settingsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openBlockSettings(block);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'grid-item-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Delete block';
  deleteBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Delete ${block.type} block?`)) {
      removeBlockById(block.id);
    }
  });

  header.appendChild(label);
  header.appendChild(settingsBtn);
  header.appendChild(deleteBtn);
  content.appendChild(header);

  // Preview area (actual component)
  const preview = document.createElement('div');
  preview.className = 'grid-item-preview';
  try {
    const builder = componentBuilders[block.type];
    if (builder) {
      const component = builder(block);
      if (component) {
        preview.appendChild(component);
      } else {
        preview.classList.add('placeholder');
        preview.textContent = `[${block.type} preview unavailable]`;
      }
    } else {
      preview.classList.add('placeholder');
      preview.textContent = `[${block.type} not found]`;
    }
  } catch (err) {
    console.error(`Error rendering ${block.type}:`, err);
    preview.classList.add('placeholder');
    preview.textContent = `[Error loading ${block.type}]`;
  }
  content.appendChild(preview);

  gridItem.appendChild(content);
  return gridItem;
}

// Add a block to the grid (for runtime additions after init)
function addBlockToGrid(block) {
  const gridItem = buildGridItem(block);
  if (gridstack) {
    gridstack.makeWidget(gridItem);
  } else {
    document.getElementById('grid').appendChild(gridItem);
  }
}

function removeBlockById(blockId) {
  const activeTab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
  if (!activeTab) return;
  const idx = activeTab.layout.findIndex(b => b.id === blockId);
  if (idx !== -1) {
    activeTab.layout.splice(idx, 1);
    loadTab(currentTabId);
    markUnsaved();
    debouncedSaveState();
  }
}

function addNewBlock(blockType) {
  const activeTab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
  if (!activeTab) return;

  const defaultSize = BLOCK_CONSTRAINTS[blockType] || { minW: 6, minH: 4 };
  const newBlock = {
    id: generateBlockId(),
    type: blockType,
    enabled: true,
    gridX: 0,
    gridY: 0,
    gridW: defaultSize.minW,
    gridH: defaultSize.minH,
    config: {}
  };
  activeTab.layout.push(newBlock);
  // Add to live grid without full tab reload
  addBlockToGrid(newBlock);
  markUnsaved();
  debouncedSaveState();
}

// Open configuration modal for a block
function openBlockSettings(block) {
  const modal = document.createElement('div');
  modal.className = 'config-modal-overlay';
  modal.innerHTML = `
    <div class="config-modal">
      <div class="config-modal-header">
        <h2>${block.type} Settings</h2>
        <button class="close-btn">✕</button>
      </div>
      <div class="config-modal-body">
        <div class="config-form" id="config-form"></div>
      </div>
      <div class="config-modal-footer">
        <button class="config-btn-cancel">Cancel</button>
        <button class="config-btn-save">Save</button>
      </div>
    </div>
  `;

  const form = modal.querySelector('#config-form');
  const blockConfig = block.config || {};

  // Generic fields
  const fields = [
    { key: 'title', label: 'Title', type: 'text', value: blockConfig.title || '' },
    { key: 'enabled', label: 'Enabled', type: 'checkbox', value: block.enabled !== false }
  ];

  // Type-specific fields
  if (block.type === 'chart-power' || block.type === 'chart-energy') {
    fields.push({
      key: 'datasets',
      label: 'Visible Datasets (comma-separated)',
      type: 'text',
      value: (blockConfig.datasets || ['load', 'solar', 'battery_charge', 'grid_import']).join(', ')
    });
  }

  fields.forEach(field => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = field.label;
    let input;
    if (field.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = field.value;
    } else {
      input = document.createElement('input');
      input.type = field.type;
      input.value = field.value;
    }
    input.dataset.key = field.key;
    if (field.type === 'checkbox') input.style.width = 'auto';
    group.appendChild(label);
    group.appendChild(input);
    form.appendChild(group);
  });

  modal.querySelector('.close-btn').addEventListener('click', () => modal.remove());
  modal.querySelector('.config-btn-cancel').addEventListener('click', () => modal.remove());
  modal.querySelector('.config-btn-save').addEventListener('click', () => {
    const inputs = modal.querySelectorAll('input');
    inputs.forEach(input => {
      const key = input.dataset.key;
      if (key === 'enabled') {
        block.enabled = input.checked;
      } else if (key === 'datasets') {
        block.config[key] = input.value.split(',').map(s => s.trim());
      } else {
        block.config[key] = input.value;
      }
    });
    // Re-render block preview to reflect changes (e.g., title)
    loadTab(currentTabId);
    markUnsaved();
    debouncedSaveState();
    modal.remove();
  });
  document.body.appendChild(modal);
}

// Load a dashboard tab into the editor grid
async function loadTab(tabId) {
  const tab = dashboardConfig.dashboards.find(db => db.id === tabId);
  if (!tab) return;

  // Ensure all blocks have IDs and grid positions
  const migratedLayout = ensureBlockIds(tab.layout);
  let needsMigration = false;
  for (let i = 0; i < migratedLayout.length; i++) {
    const b = migratedLayout[i];
    if (b.gridX === undefined || b.gridY === undefined || b.gridW === undefined || b.gridH === undefined) {
      needsMigration = true;
      break;
    }
  }
  if (needsMigration) {
    let y = 0;
    migratedLayout.forEach(b => {
      b.gridX = 0;
      b.gridY = y;
      b.gridW = 12;
      b.gridH = BLOCK_CONSTRAINTS[b.type]?.minH || 4;
      y += b.gridH;
    });
    tab.layout = migratedLayout;
    // Auto-save migration immediately (silent)
    await saveDashboardConfig(dashboardConfig).catch(e => console.warn('Auto-save migration failed:', e));
  } else {
    tab.layout = migratedLayout;
  }

  // Clear grid
  const container = document.getElementById('grid');
  container.innerHTML = '';
  if (gridstack) { gridstack.destroy(false); gridstack = null; }

  // Build all blocks and append to container BEFORE GridStack.init
  tab.layout.forEach(block => {
    if (block.enabled === false) return;
    const gridItem = buildGridItem(block);
    container.appendChild(gridItem);
  });

  // Initialize GridStack in edit mode (auto-widgetizes existing children)
  gridstack = GridStack.init({
    column: 12,
    float: false,
    animate: true,
    alwaysShowResizeHandle: true,
    resizable: { handles: 'e, se, s, sw, w, nw, ne, n' },
    disableDrag: false,
    disableResize: false,
    minRow: 1
  }, container);

  // Listen for changes
  gridstack.on('change', () => {
    syncGridToConfig();
    debouncedSaveState();
    markUnsaved();
  });
  gridstack.on('dragstop', () => {
    syncGridToConfig();
    debouncedSaveState();
    markUnsaved();
  });
  gridstack.on('resizestop', () => {
    syncGridToConfig();
    debouncedSaveState();
    markUnsaved();
  });

  // Palette drag-and-drop onto grid
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    container.style.outline = '2px dashed var(--accent)';
    container.style.outlineOffset = '-4px';
  });

  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      container.style.outline = '';
    }
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.style.outline = '';
    const blockType = e.dataTransfer.getData('blockType');
    if (blockType) addNewBlock(blockType);
  });
}

// Switch to another dashboard tab
async function switchTab(tabId) {
  if (unsavedChanges && !confirm('You have unsaved changes. Switch tab anyway?')) {
    document.getElementById('tab-select').value = currentTabId;
    return;
  }
  currentTabId = tabId;
  await loadTab(tabId);
  // Reset history for new tab
  history = [];
  historyIndex = -1;
  saveState(); // initial snapshot
  clearUnsaved();
}

// Reset current tab layout to a simple stacked order
function resetLayout() {
  if (!confirm('Reset layout to default for this dashboard? This cannot be undone.')) return;
  const activeTab = dashboardConfig.dashboards.find(db => db.id === currentTabId);
  if (!activeTab) return;
  let y = 0;
  activeTab.layout.forEach(block => {
    block.gridX = 0;
    block.gridY = y;
    block.gridW = 12;
    block.gridH = BLOCK_CONSTRAINTS[block.type]?.minH || 4;
    y += block.gridH;
  });
  loadTab(currentTabId);
  markUnsaved();
  debouncedSaveState();
}

// Save and exit to main dashboard
async function saveAndExit() {
  try {
    showLoading('Saving layout...');
    syncGridToConfig();
    await saveDashboardConfig(dashboardConfig);
    clearUnsaved();
    hideLoading();
    window.location.href = `/?tab=${currentTabId}`;
  } catch (err) {
    hideLoading();
    alert('Save failed: ' + err.message);
  }
}

// Export layout as JSON file
function exportConfig() {
  const dataStr = JSON.stringify(dashboardConfig, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dashboard-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Import layout from JSON file
function importConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      showLoading('Importing layout...');
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!imported.dashboards || !Array.isArray(imported.dashboards)) {
        throw new Error('Invalid configuration format');
      }
      dashboardConfig = imported;
      // Re-populate tab selector
      const tabSelect = document.getElementById('tab-select');
      tabSelect.innerHTML = '';
      dashboardConfig.dashboards.forEach(db => {
        const opt = document.createElement('option');
        opt.value = db.id;
        opt.textContent = db.name;
        tabSelect.appendChild(opt);
      });
      currentTabId = dashboardConfig.dashboards[0]?.id;
      if (currentTabId) {
        await loadTab(currentTabId);
      }
      hideLoading();
      alert('Configuration imported successfully');
      markUnsaved();
    } catch (err) {
      hideLoading();
      alert('Import failed: ' + err.message);
    }
  });
  input.click();
}

// Populate block palette from existing componentBuilders
function populateBlocksPalette() {
  const palette = document.getElementById('available-blocks');
  palette.innerHTML = '';
  const validTypes = Object.keys(componentBuilders);
  const displayNames = {
    'flow-card': '🔄 Flow Card',
    'metric-cards': '📊 Metric Cards',
    'chart-power': '⚡ Power Chart',
    'chart-energy': '📈 Energy Chart',
    'grid-card': '🔌 Grid Card',
    'forecast-banner': '☀️ Solar Forecast',
    'data-table-daily': '📋 Daily Data',
    'data-table-monthly': '📅 Monthly Data',
    'savings-summary': '💰 Savings Summary',
    'weather-block': '🌤️ Weather Block',
    'battery-block': '🔋 Battery Block'
  };
  validTypes.forEach(type => {
    const label = displayNames[type] || type;
    const item = document.createElement('div');
    item.className = 'block-item';
    item.textContent = label;
    item.draggable = true;
    item.dataset.blockType = type;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('blockType', type);
    });
    palette.appendChild(item);
  });
}

// Initialization
async function initEditor() {
  showLoading('Loading editor...');
  try {
    dashboardConfig = await fetchDashboardConfig();
    currentTabId = new URLSearchParams(window.location.search).get('tab') || dashboardConfig.dashboards[0]?.id;
    if (!currentTabId) throw new Error('No dashboard found');

    // Populate tab selector
    const tabSelect = document.getElementById('tab-select');
    dashboardConfig.dashboards.forEach(db => {
      const opt = document.createElement('option');
      opt.value = db.id;
      opt.textContent = db.name;
      opt.selected = db.id === currentTabId;
      tabSelect.appendChild(opt);
    });
    tabSelect.addEventListener('change', (e) => switchTab(e.target.value));

    populateBlocksPalette();
    await loadTab(currentTabId);
    saveState(); // initial history

    // Setup event listeners
    document.getElementById('undo-btn').addEventListener('click', undo);
    document.getElementById('redo-btn').addEventListener('click', redo);
    document.getElementById('reset-btn').addEventListener('click', resetLayout);
    document.getElementById('save-btn').addEventListener('click', saveAndExit);
    document.getElementById('export-btn').addEventListener('click', exportConfig);
    document.getElementById('import-btn').addEventListener('click', importConfig);

    // Disable WebSocket and polling in editor
    if (window.ws) window.ws.close();
    if (window.updateInterval) clearInterval(window.updateInterval);
    hideLoading();
  } catch (err) {
    hideLoading();
    console.error('Editor init failed:', err);
    alert('Failed to load editor: ' + err.message);
  }
}

// Start
initEditor();
