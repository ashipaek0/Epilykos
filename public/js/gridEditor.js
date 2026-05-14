import { dashboardConfig, saveDashboardConfig } from './dashboard.js';
import { componentBuilders } from './components/index.js';

let grid = null;
let editMode = false;
let saveTimeout = null;
let currentDashboardConfig = null;

export function setDashboardConfigRef(config) {
  currentDashboardConfig = config;
}

export function isEditMode() {
  return editMode;
}

export function enableEditMode() {
  if (!grid) return;
  editMode = true;
  grid.setStatic(false);
  grid.enableMove();
  grid.enableResize();
  // Add drag handles to each widget if not already
  document.querySelectorAll('.grid-stack-item').forEach(item => {
    const content = item.querySelector('.grid-stack-item-content');
    if (!content.querySelector('.grid-drag-handle')) {
      const handle = document.createElement('div');
      handle.className = 'grid-drag-handle';
      handle.innerHTML = '⋮⋮';
      handle.style.cursor = 'move';
      handle.style.position = 'absolute';
      handle.style.top = '4px';
      handle.style.left = '4px';
      handle.style.fontSize = '20px';
      handle.style.zIndex = '10';
      content.appendChild(handle);
    }
  });
}

export function disableEditMode() {
  if (!grid) return;
  editMode = false;
  grid.setStatic(true);
  grid.disableMove();
  grid.disableResize();
  // Remove drag handles
  document.querySelectorAll('.grid-drag-handle').forEach(handle => handle.remove());
}

function debounceSaveLayout() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (!grid || !currentDashboardConfig) return;
    const items = grid.save(false);
    const activeDashboard = currentDashboardConfig.dashboards.find(db => db.id === currentDashboardConfig.activeDashboard);
    if (!activeDashboard) return;
    // Update layout with new positions and sizes
    items.forEach((item, idx) => {
      if (activeDashboard.layout[idx]) {
        activeDashboard.layout[idx].x = item.x;
        activeDashboard.layout[idx].y = item.y;
        activeDashboard.layout[idx].w = item.w;
        activeDashboard.layout[idx].h = item.h;
      }
    });
    saveDashboardConfig(currentDashboardConfig);
  }, 500);
}

export function initGrid(containerId, layout) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '<div id="dashboard-grid" class="grid-stack"></div>';
  const gridEl = document.getElementById('dashboard-grid');
  grid = GridStack.init({
    column: 12,
    cellHeight: 80,
    disableDrag: true,
    disableResize: true,
    draggable: { handle: '.grid-drag-handle' },
    resizable: { handles: 'e, se, s, sw, w' }
  }, gridEl);
  
  // Add widgets from layout
  layout.forEach(block => {
    const builder = componentBuilders[block.type];
    if (!builder) return;
    const content = builder(block);
    const widget = grid.addWidget(content, {
      x: block.x || 0,
      y: block.y || 0,
      w: block.w || 12,
      h: block.h || 4,
      minW: block.minW || 2,
      minH: block.minH || 2,
      id: block.id || `block-${Date.now()}-${Math.random()}`
    });
    // Add drag handle if needed later (done in enableEditMode)
  });
  
  grid.on('change', () => {
    if (editMode) debounceSaveLayout();
  });
  
  return grid;
}
