import { fetchDashboardConfig, saveDashboardConfig, fetchDashboardState } from './api.js';
import { componentBuilders } from './components/index.js';
import { initTheme } from './theme.js';
import { GROUPS, BLOCKS, blockInfo, icon } from './editor-catalog.js';
import { openDialog, openMenu, closeMenu, isMenuOpen, toast, hideToast } from './editor-ui.js';
import { updateCards } from './cards-update.js';
import { ensureChartJS } from './chartLoader.js';
import { initPowerChart, initEnergyChart, initMetricChart } from './charts.js';
import { updateDailyTable, updateMonthlyTable } from './tables.js';
import { applyBlockStyle, fontScale } from './components/blockStyle.js';
// Builders by block type. A Map has no inherited entries, so a saved or imported
// layout naming "constructor" / "toString" can never resolve to a callable.
const BLOCK_BUILDERS = new Map(Object.entries(componentBuilders));

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

var GRID_COLUMNS = 12, CELL_HEIGHT = 50;

var grid = null, dashboardConfig = null, currentTabId = null;
var selectedBlockId = null;      // block shown in the inspector
var inspectorTab = 'data';       // data | style | layout
var availableMetrics = [];       // metric names from dashboard state
var metricsPromise = null;       // fetched once per editor session
var availableRestSources = [];   // REST source names from /api/settings external_sources (S3)
var readOnly = false;

function $(id) { return document.getElementById(id); }
function isNarrow() { return window.matchMedia('(max-width: 900px)').matches; }

function currentTab() {
  return dashboardConfig.dashboards.find(function(db) { return db.id === currentTabId; }) || null;
}
function findBlock(id) {
  var tab = currentTab();
  return tab ? tab.layout.find(function(b) { return b.id === id; }) || null : null;
}
function gridItemEl(id) {
  return document.querySelector('.grid-stack-item[data-block-id="' + CSS.escape(id) + '"]');
}
function newBlockId() { return 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function showLoading(msg) { var o = $('loading-overlay'); $('loading-message').textContent = msg; o.hidden = false; }
function hideLoading() { $('loading-overlay').hidden = true; }

/**
 * Copy grid positions back onto the current tab's blocks. Existing block
 * objects are updated in place so every saved field (enabled, styling,
 * config, ...) survives; blocks the editor could not render (unknown types)
 * are kept as they are instead of being dropped.
 */
function syncLayoutFromGrid() {
  var tab = currentTab();
  if (!tab || !grid) return;
  var byId = new Map(tab.layout.map(function(b) { return [b.id, b]; }));
  var seen = new Set();
  var layout = [];
  grid.getGridItems().forEach(function(el) {
    var n = el.gridstackNode;
    var block = byId.get(el.dataset.blockId);
    if (!block) return;
    block.gridX = n.x; block.gridY = n.y; block.gridW = n.w; block.gridH = n.h;
    layout.push(block);
    seen.add(block.id);
  });
  tab.layout.forEach(function(b) { if (!seen.has(b.id)) layout.push(b); });
  tab.layout = layout;
}

// ── Saving ───────────────────────────────────────────────────────────────
// Every change autosaves after a short pause. One status in the top bar says
// whether the work is saved; there is no separate "save" step.

var saveTimer = null, saving = null, saveState = 'saved', lastSaveError = null, lastSavedAt = null;

function setSaveStatus(state) {
  saveState = state;
  var el = $('save-status');
  if (!el) return;
  el.dataset.state = state;
  el.title = '';
  if (state === 'saving' || state === 'pending') {
    el.innerHTML = '<span class="ed-status-icon is-spinning">' + icon('spinner', 14) + '</span>Saving…';
  } else if (state === 'saved') {
    el.innerHTML = '<span class="ed-status-icon">' + icon('check', 14) + '</span>Saved';
    if (lastSavedAt) el.title = 'Saved at ' + lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (state === 'error') {
    var expired = lastSaveError && /\((401|403)\)/.test(String(lastSaveError.message || ''));
    el.innerHTML = '<span class="ed-status-icon">' + icon('alert', 14) + '</span>' +
      (expired ? 'Signed out, not saved' : "Couldn't save") +
      (expired ? '<a class="ed-status-action" href="/login" target="_blank" rel="noopener">Sign in</a>' : '') +
      '<button type="button" class="ed-status-action" id="save-retry">Retry</button>';
    el.title = expired
      ? 'Your session ended. Sign in (opens a new tab), then press Retry.'
      : (lastSaveError ? String(lastSaveError.message || lastSaveError) : '');
    var retry = $('save-retry');
    if (retry) retry.addEventListener('click', function() { flushSave(); });
  } else if (state === 'readonly') {
    el.innerHTML = '<span class="ed-status-icon">' + icon('lock', 14) + '</span>Read-only';
  }
}

function scheduleSave(delay) {
  if (readOnly) return;
  clearTimeout(saveTimer);
  setSaveStatus('pending');
  saveTimer = setTimeout(flushSave, delay == null ? 600 : delay);
}

/** Save now. Resolves true when everything is saved. */
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (readOnly) return false;
  while (saving) await saving;
  syncLayoutFromGrid();
  setSaveStatus('saving');
  saving = saveDashboardConfig(dashboardConfig).then(function() { return true; }, function(e) {
    console.warn('Save failed:', e);
    lastSaveError = e;
    return false;
  });
  var ok = await saving;
  saving = null;
  if (saveTimer) return ok;  // a newer change is already queued
  if (ok) { lastSaveError = null; lastSavedAt = new Date(); setSaveStatus('saved'); }
  else setSaveStatus('error');
  return ok;
}

// ── Undo / redo ──────────────────────────────────────────────────────────
// Snapshots of the whole config, taken before each change.

var undoStack = [], redoStack = [];

function snapshot() {
  syncLayoutFromGrid();
  return JSON.stringify({ config: dashboardConfig, tab: currentTabId, selected: selectedBlockId });
}
function pushUndo() {
  if (readOnly) return;
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}
function restoreSnapshot(snap) {
  var s = JSON.parse(snap);
  dashboardConfig = s.config;
  var tabId = dashboardConfig.dashboards.some(function(db) { return db.id === s.tab; }) ? s.tab : dashboardConfig.dashboards[0].id;
  loadTab(tabId, { skipSync: true, keepSelection: s.selected });
  scheduleSave(0);
}
function undo() {
  if (!undoStack.length || readOnly) return;
  hideToast();
  redoStack.push(snapshot());
  restoreSnapshot(undoStack.pop());
  updateUndoButtons();
}
function redo() {
  if (!redoStack.length || readOnly) return;
  hideToast();
  undoStack.push(snapshot());
  restoreSnapshot(redoStack.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  $('undo-btn').disabled = readOnly || !undoStack.length;
  $('redo-btn').disabled = readOnly || !redoStack.length;
}

function uniqueDashboardId(id, usedIds) {
  var candidate = id;
  var suffix = 2;
  while (usedIds.has(candidate)) candidate = id + '_' + suffix++;
  return candidate;
}

function applyDashboardImport(currentConfig, imported, choice) {
  if (!imported || !Array.isArray(imported.dashboards)) throw new Error('Invalid format: dashboards must be an array');
  var stagedDashboards = imported.dashboards.map(function(db) {
    if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('Invalid dashboard entry');
    if (typeof db.id !== 'string' || !db.id.trim()) throw new Error('Invalid dashboard id');
    return JSON.parse(JSON.stringify(db));
  });
  if (choice === 'Replace') return Object.assign({}, imported, { dashboards: stagedDashboards });
  if (choice !== 'Append') throw new Error('Invalid import choice');
  var existingDashboards = currentConfig.dashboards;
  var usedIds = new Set(existingDashboards.map(function(db) { return db.id; }));
  stagedDashboards.forEach(function(db) {
    db.id = uniqueDashboardId(db.id, usedIds);
    usedIds.add(db.id);
  });
  return Object.assign({}, currentConfig, { dashboards: existingDashboards.concat(stagedDashboards) });
}

// ── Settings forms ──────────────────────────────────────────────────────
// Each block type's fields, rendered into the inspector. Field ids keep their
// historical "modal-" prefix; readSettingsForm() reads them back.

/** Build a <select> dropdown with metric options */
function metricSelect(selectedName, existingId, extraOptions) {
  var id = existingId || ('ms_' + Math.random().toString(36).slice(2,8));
  var sel = '<select id="' + id + '" data-ui="input">';
  sel += '<option value="">-- select --</option>';
  for (var i = 0; i < availableMetrics.length; i++) {
    var m = availableMetrics[i];
    sel += '<option value="' + escHtml(m) + '"' + (m === selectedName ? ' selected' : '') + '>' + escHtml(m) + '</option>';
  }
  // Additive per-block overrides (e.g. computed 'battery_power' for chart-power) not present as live metrics.
  if (extraOptions) {
    for (var j = 0; j < extraOptions.length; j++) {
      var eo = extraOptions[j];
      if (availableMetrics.indexOf(eo.value) !== -1) continue;
      sel += '<option value="' + escHtml(eo.value) + '"' + (eo.value === selectedName ? ' selected' : '') + '>' + escHtml(eo.label) + '</option>';
    }
  }
  sel += '</select>';
  return sel;
}

// Text size choices, saved as a percentage. Older free-text values
// ("1.2rem", "18px") still work and show as a custom choice.
var FONT_SIZES = [['', 'Default'], ['80%', 'Smaller (80%)'], ['90%', 'Small (90%)'], ['115%', 'Large (115%)'], ['130%', 'Larger (130%)'], ['150%', 'Extra large (150%)'], ['175%', 'Huge (175%)']];
function fontSizeSelect(current) {
  var cur = String(current || '');
  var known = FONT_SIZES.some(function(o) { return o[0] === cur; });
  var opts = FONT_SIZES.map(function(o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>'; });
  if (!known) {
    var k = fontScale(cur);
    opts.push('<option value="' + escHtml(cur) + '" selected>Custom (' + escHtml(cur) + (k ? ', ' + Math.round(k * 100) + '%' : '') + ')</option>');
  }
  return '<select id="modal-fontsize" data-ui="input">' + opts.join('') + '</select>';
}

/** Build common appearance fields: transparent, bgColor, fontColor, fontSize (Style tab) */
function buildAppearanceFields(block) {
  var config = block.config || {};
  var bgColor = block.bgColor || config.bgColor || '';
  var fontColor = block.fontColor || config.fontColor || '';
  var fontSize = block.fontSize || config.fontSize || '';
  var transparent = !!(block.transparent || config.transparent);
  return [
    '<fieldset data-ui="section">',
    '<legend data-ui="legend">Colors and text</legend>',
    '<div data-ui="grid2">',
    '<span class="toggle-wrap" data-ui="span"><label class="toggle-switch"><input type="checkbox" id="modal-transparent"' + (transparent ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-transparent">Transparent</label></span>',
    '<label data-ui="label">Bg Color <input type="color" id="modal-bgcolor" value="' + escHtml(bgColor) + '" data-dirty="false" data-ui="color"></label>',
    '<label data-ui="label">Font Color <input type="color" id="modal-fontcolor" value="' + escHtml(fontColor) + '" data-dirty="false" data-ui="color"></label>',
    '</div>',
    '<label data-ui="field">Text size ' + fontSizeSelect(fontSize) + '</label>',
    '</fieldset>'
  ].join('\n');
}

/** Flow Card: metrics object with dropdowns */
function buildFlowCardForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var slots = ['solar','battery_soc','battery_charge','battery_discharge','consumption','grid_import','grid_export'];
  var labels = {solar:'Solar',battery_soc:'Battery SoC',battery_charge:'Battery Charge',battery_discharge:'Battery Discharge',consumption:'Consumption',grid_import:'Grid Import',grid_export:'Grid Export'};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Metrics Map</legend>';
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    html += '<div data-ui="row">';
    html += '<span data-ui="row-label">' + labels[s] + '</span>';
    html += '<div data-ui="grow">' + metricSelect(metrics[s] || s, 'modal-metric-' + s) + '</div>';
    html += '</div>';
  }
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-showgauge"' + (cfg.showGauge !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-showgauge">Show solar gauge</label></span>';
  html += '</fieldset>';
  return html;
}

/** System Topology (flow-card-2) / Flow Card Square / Flow Card Square 2: same metrics shape */
function buildSystemTopologyForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var slots = ['solar','grid_import','battery_charge','battery_soc','consumption','battery_discharge','grid_export'];
  var labels = {solar:'Solar',grid_import:'Grid Import',battery_charge:'Battery Charge',battery_soc:'Battery SoC',consumption:'Consumption',battery_discharge:'Battery Discharge',grid_export:'Grid Export'};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Metrics Map</legend>';
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    html += '<div data-ui="row">';
    html += '<span data-ui="row-label">' + labels[s] + '</span>';
    html += '<div data-ui="grow">' + metricSelect(metrics[s] || s, 'modal-metric-' + s) + '</div>';
    html += '</div>';
  }
  html += '<label data-ui="field">Inverter Image URL <input type="text" id="modal-inverter-image" value="' + escHtml(cfg.inverter_image || '') + '" placeholder="https://..." data-ui="input"></label>';
  html += '</fieldset>';
  return html;
}

/** Multi-Value Card: metrics array */
function buildMultiValueForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Metrics Array</legend>';
  html += '<div id="mv-rows"></div>';
  html += '<button type="button" id="mv-add-row" data-ui="add">+ Add Row</button>';
  html += '</fieldset>';
  html += '<script id="mv-data" type="application/json">' + JSON.stringify(metrics).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderMultiValueRows(container) {
  var dataEl = container.querySelector('#mv-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#mv-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="mv-row" data-ui="list-row">';
    html += '<input type="text" class="mv-label" value="' + escHtml(r.label || '') + '" placeholder="Label" data-ui="input grow">';
    html += metricSelect(r.metric || '', 'mv-metric-' + i);
    html += '<input type="text" class="mv-unit" value="' + escHtml(r.unit || '') + '" placeholder="Unit" data-ui="input unit">';
    html += '<button type="button" class="mv-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove row">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  // Add row handler
  var addBtn = container.querySelector('#mv-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', unit: '' });
      dataEl.textContent = JSON.stringify(current);
      renderMultiValueRows(container);
    };
  }
  // Remove handlers
  container.querySelectorAll('.mv-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderMultiValueRows(container);
    };
  });
}

/** Bar Gauge: metrics array with min/max/color/gradient */
function buildBarGaugeForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Metrics Array</legend>';
  html += '<div id="bg-rows"></div>';
  html += '<button type="button" id="bg-add-row" data-ui="add">+ Add Row</button>';
  html += '</fieldset>';
  html += '<script id="bg-data" type="application/json">' + JSON.stringify(metrics).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderBarGaugeRows(container) {
  var dataEl = container.querySelector('#bg-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#bg-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="bg-row" data-ui="card grid2">';
    html += '<input type="text" class="bg-label" value="' + escHtml(r.label || '') + '" placeholder="Label" data-ui="input span">';
    html += '<div data-ui="span flex">';
    html += metricSelect(r.metric || '', 'bg-metric-' + i);
    html += '<input type="text" class="bg-unit" value="' + escHtml(r.unit || '') + '" placeholder="Unit" data-ui="input unit">';
    html += '</div>';
    html += '<input type="number" class="bg-min" value="' + escHtml(r.min ?? 0) + '" placeholder="Min" data-ui="input">';
    html += '<input type="number" class="bg-max" value="' + escHtml(r.max ?? 100) + '" placeholder="Max" data-ui="input">';
    html += '<label data-ui="inline-label">Color <input type="color" class="bg-color" value="' + escHtml(r.color || '') + '" data-ui="swatch"></label>';
    html += '<label data-ui="inline-label">Grad <input type="text" class="bg-gradient" value="' + escHtml(r.gradient || '') + '" placeholder="#f00,#0f0" data-ui="input"></label>';
    html += '<button type="button" class="bg-remove row-remove-btn" data-idx="' + i + '" data-ui="span" aria-label="Remove row">✕ Remove</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#bg-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', unit: '', min: 0, max: 100, color: '', gradient: '' });
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRows(container);
    };
  }
  container.querySelectorAll('.bg-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRows(container);
    };
  });
}

/** Bar Gauge Retro: same as bar gauge + segments */
function buildBarGaugeRetroForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Metrics Array</legend>';
  html += '<div id="bgr-rows"></div>';
  html += '<button type="button" id="bgr-add-row" data-ui="add">+ Add Row</button>';
  html += '</fieldset>';
  html += '<script id="bgr-data" type="application/json">' + JSON.stringify(metrics).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderBarGaugeRetroRows(container) {
  var dataEl = container.querySelector('#bgr-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#bgr-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="bgr-row" data-ui="card grid3">';
    html += '<input type="text" class="bgr-label" value="' + escHtml(r.label || '') + '" placeholder="Label" data-ui="input span">';
    html += '<div data-ui="span flex">';
    html += metricSelect(r.metric || '', 'bgr-metric-' + i);
    html += '<input type="text" class="bgr-unit" value="' + escHtml(r.unit || '') + '" placeholder="Unit" data-ui="input unit">';
    html += '</div>';
    html += '<input type="number" class="bgr-min" value="' + escHtml(r.min ?? 0) + '" placeholder="Min" data-ui="input">';
    html += '<input type="number" class="bgr-max" value="' + escHtml(r.max ?? 100) + '" placeholder="Max" data-ui="input">';
    html += '<input type="number" class="bgr-segments" value="' + escHtml(r.segments || 10) + '" placeholder="Segments" data-ui="input">';
    html += '<label data-ui="inline-label"><span class="ed-visually-hidden">Color</span><input type="color" class="bgr-color" value="' + escHtml(r.color || '') + '" data-ui="swatch"></label>';
    html += '<label data-ui="inline-label">Grad <input type="text" class="bgr-gradient" value="' + escHtml(r.gradient || '') + '" placeholder="#f00,#0f0" data-ui="input"></label>';
    html += '<button type="button" class="bgr-remove row-remove-btn" data-idx="' + i + '" data-ui="span" aria-label="Remove row">✕ Remove</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#bgr-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', unit: '', min: 0, max: 100, color: '', gradient: '', segments: 10 });
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRetroRows(container);
    };
  }
  container.querySelectorAll('.bgr-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderBarGaugeRetroRows(container);
    };
  });
}

/** Bar Single: one metric, history-backed vertical bars, banded colors */
var BAR_SINGLE_WARM = ['#a8a29e', '#f59e0b', '#b45309', '#166534'];
function buildBarSingleForm(block) {
  var cfg = block.config || {};
  var range = cfg.range || '24h';
  var bucket = cfg.bucket || '1h';
  // 'auto' resolves to the component default band mode (see normalizeBarConfig in barSingleCard.js).
  var bandMode = cfg.bandMode === 'fixed' ? 'fixed' : 'auto';
  var bands = cfg.bands || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Bar Single</legend>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Metric</span>';
  html += '<div data-ui="grow">' + metricSelect(cfg.metric || '', 'modal-bar-metric') + '</div>';
  html += '</div>';
  html += '<div data-ui="grid3">';
  html += '<label data-ui="label">Range <select id="modal-bar-range" data-ui="input">'
    + '<option value="24h"' + (range === '24h' ? ' selected' : '') + '>24h</option>'
    + '<option value="7d"' + (range === '7d' ? ' selected' : '') + '>7d</option></select></label>';
  html += '<label data-ui="label">Bucket <select id="modal-bar-bucket" data-ui="input">'
    + '<option value="15m"' + (bucket === '15m' ? ' selected' : '') + '>15m</option>'
    + '<option value="1h"' + (bucket === '1h' ? ' selected' : '') + '>1h</option>'
    + '<option value="1d"' + (bucket === '1d' ? ' selected' : '') + '>1d</option></select></label>';
  html += '<label data-ui="label">Bands <select id="modal-bar-bandmode" data-ui="input">'
    + '<option value="auto"' + (bandMode === 'auto' ? ' selected' : '') + '>Auto</option>'
    + '<option value="fixed"' + (bandMode === 'fixed' ? ' selected' : '') + '>Fixed</option></select></label>';
  html += '</div></fieldset>';
  html += '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Bands</legend>';
  html += '<div id="bar-bands-rows"></div>';
  html += '<button type="button" id="bar-bands-add-row" data-ui="add">+ Add Band</button>';
  html += '</fieldset>';
  html += '<script id="bar-bands-data" type="application/json">' + JSON.stringify(bands).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderBarSingleRows(container) {
  var dataEl = container.querySelector('#bar-bands-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#bar-bands-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="bar-band-row" data-ui="list-row">';
    html += '<input type="number" step="any" class="bar-band-to" value="' + escHtml(r.to ?? '') + '" placeholder="Up to" title="Values at or below this threshold use this color" data-ui="input grow">';
    html += '<label data-ui="inline-label">Color <input type="color" class="bar-band-color" value="' + escHtml(r.color || BAR_SINGLE_WARM[i % BAR_SINGLE_WARM.length]) + '" data-ui="swatch"></label>';
    html += '<button type="button" class="bar-band-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove band">X</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#bar-bands-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ to: '', color: BAR_SINGLE_WARM[current.length % BAR_SINGLE_WARM.length] });
      dataEl.textContent = JSON.stringify(current);
      renderBarSingleRows(container);
    };
  }
  container.querySelectorAll('.bar-band-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderBarSingleRows(container);
    };
  });
}

/** Bar Stacked: N series (label+metric+color), shared range/bucket/agg */
var BAR_STACKED_WARM = ['#a8a29e', '#f59e0b', '#b45309', '#166534'];
function buildBarStackedForm(block) {
  var cfg = block.config || {};
  var range = cfg.range || '24h';
  var bucket = cfg.bucket || '1h';
  var agg = cfg.agg || 'avg';
  var metrics = cfg.metrics || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Bar Stacked</legend>';
  html += '<div data-ui="grid3">';
  html += '<label data-ui="label">Range <select id="modal-bs-range" data-ui="input">'
    + '<option value="24h"' + (range === '24h' ? ' selected' : '') + '>24h</option>'
    + '<option value="7d"' + (range === '7d' ? ' selected' : '') + '>7d</option></select></label>';
  html += '<label data-ui="label">Bucket <select id="modal-bs-bucket" data-ui="input">'
    + '<option value="15m"' + (bucket === '15m' ? ' selected' : '') + '>15m</option>'
    + '<option value="1h"' + (bucket === '1h' ? ' selected' : '') + '>1h</option>'
    + '<option value="1d"' + (bucket === '1d' ? ' selected' : '') + '>1d</option></select></label>';
  html += '<label data-ui="label">Agg <select id="modal-bs-agg" data-ui="input">'
    + '<option value="avg"' + (agg === 'avg' ? ' selected' : '') + '>avg</option>'
    + '<option value="sum"' + (agg === 'sum' ? ' selected' : '') + '>sum</option>'
    + '<option value="min"' + (agg === 'min' ? ' selected' : '') + '>min</option>'
    + '<option value="max"' + (agg === 'max' ? ' selected' : '') + '>max</option>'
    + '<option value="last"' + (agg === 'last' ? ' selected' : '') + '>last</option></select></label>';
  html += '</div></fieldset>';
  html += '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Series</legend>';
  html += '<div id="bs-rows"></div>';
  html += '<button type="button" id="bs-add-row" data-ui="add">+ Add Series</button>';
  html += '</fieldset>';
  html += '<script id="bs-data" type="application/json">' + JSON.stringify(metrics).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderBarStackedRows(container) {
  var dataEl = container.querySelector('#bs-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#bs-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="bs-row" data-ui="card grid2">';
    html += '<input type="text" class="bs-label" value="' + escHtml(r.label || '') + '" placeholder="Label" data-ui="input span">';
    html += '<div data-ui="span flex">';
    html += metricSelect(r.metric || '', 'bs-metric-' + i);
    html += '<label data-ui="inline-label">Color <input type="color" class="bs-color" value="' + escHtml(r.color || BAR_STACKED_WARM[i % BAR_STACKED_WARM.length]) + '" data-ui="swatch"></label>';
    html += '</div>';
    html += '<button type="button" class="bs-remove row-remove-btn" data-idx="' + i + '" data-ui="span" aria-label="Remove series">X Remove</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#bs-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', color: '' });
      dataEl.textContent = JSON.stringify(current);
      renderBarStackedRows(container);
    };
  }
  container.querySelectorAll('.bs-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderBarStackedRows(container);
    };
  });
}

/** Bar Threshold: single metric, valueAgg, bandMode, bands */
var BAR_THRESHOLD_WARM = ['#a8a29e', '#f59e0b', '#b45309', '#166534'];
function buildBarThresholdForm(block) {
  var cfg = block.config || {};
  var range = cfg.range || '24h';
  var bucket = cfg.bucket || '1h';
  var valueAgg = cfg.valueAgg === 'avg' ? 'avg' : 'last';
  var bandMode = cfg.bandMode === 'fixed' ? 'fixed' : 'auto';
  var bands = cfg.bands || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Bar Threshold</legend>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Metric</span>';
  html += '<div data-ui="grow">' + metricSelect(cfg.metric || '', 'modal-bt-metric') + '</div>';
  html += '</div>';
  html += '<div data-ui="grid4">';
  html += '<label data-ui="label">Range <select id="modal-bt-range" data-ui="input">'
    + '<option value="24h"' + (range === '24h' ? ' selected' : '') + '>24h</option>'
    + '<option value="7d"' + (range === '7d' ? ' selected' : '') + '>7d</option></select></label>';
  html += '<label data-ui="label">Bucket <select id="modal-bt-bucket" data-ui="input">'
    + '<option value="15m"' + (bucket === '15m' ? ' selected' : '') + '>15m</option>'
    + '<option value="1h"' + (bucket === '1h' ? ' selected' : '') + '>1h</option>'
    + '<option value="1d"' + (bucket === '1d' ? ' selected' : '') + '>1d</option></select></label>';
  html += '<label data-ui="label">Value <select id="modal-bt-valueagg" data-ui="input">'
    + '<option value="last"' + (valueAgg === 'last' ? ' selected' : '') + '>last</option>'
    + '<option value="avg"' + (valueAgg === 'avg' ? ' selected' : '') + '>avg</option></select></label>';
  html += '<label data-ui="label">Bands <select id="modal-bt-bandmode" data-ui="input">'
    + '<option value="auto"' + (bandMode === 'auto' ? ' selected' : '') + '>Auto</option>'
    + '<option value="fixed"' + (bandMode === 'fixed' ? ' selected' : '') + '>Fixed</option></select></label>';
  html += '</div></fieldset>';
  html += '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Bands</legend>';
  html += '<div id="bt-bands-rows"></div>';
  html += '<button type="button" id="bt-bands-add-row" data-ui="add">+ Add Band</button>';
  html += '</fieldset>';
  html += '<script id="bt-bands-data" type="application/json">' + JSON.stringify(bands).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderBarThresholdRows(container) {
  var dataEl = container.querySelector('#bt-bands-data');
  var rows = [];
  try { rows = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#bt-bands-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    html += '<div class="bt-band-row" data-ui="list-row">';
    html += '<input type="number" step="any" class="bt-band-to" value="' + escHtml(r.to ?? '') + '" placeholder="Up to" title="Values at or below this threshold use this color" data-ui="input grow">';
    html += '<label data-ui="inline-label">Color <input type="color" class="bt-band-color" value="' + escHtml(r.color || BAR_THRESHOLD_WARM[i % BAR_THRESHOLD_WARM.length]) + '" data-ui="swatch"></label>';
    html += '<button type="button" class="bt-band-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove band">X</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#bt-bands-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ to: '', color: BAR_THRESHOLD_WARM[current.length % BAR_THRESHOLD_WARM.length] });
      dataEl.textContent = JSON.stringify(current);
      renderBarThresholdRows(container);
    };
  }
  container.querySelectorAll('.bt-band-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderBarThresholdRows(container);
    };
  });
}

/** Gauge / Half Gauge / Half Gauge 2: single metric */
function buildGaugeForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Gauge Config</legend>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Metric</span>';
  html += '<div data-ui="grow">' + metricSelect(cfg.metric || '', 'modal-metric-gauge') + '</div>';
  html += '</div>';
  html += '<label data-ui="field">Title <input type="text" id="modal-gauge-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
  html += '<div data-ui="grid2">';
  html += '<label data-ui="label">Min <input type="number" id="modal-gauge-min" value="' + escHtml(cfg.min ?? 0) + '" data-ui="input"></label>';
  html += '<label data-ui="label">Max <input type="number" id="modal-gauge-max" value="' + escHtml(cfg.max ?? 100) + '" data-ui="input"></label>';
  html += '</div>';
  html += '<label data-ui="field">Color <input type="color" id="modal-gauge-color" value="' + escHtml(cfg.color || '#f59e0b') + '" data-ui="color"></label>';
  html += '</fieldset>';
  return html;
}

/** Metric Cards: cards array */
function buildMetricCardsForm(block) {
  var cfg = block.config || {};
  var cards = block.cards || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Metric Cards</legend>';
  html += '<div id="mc-rows"></div>';
  html += '<button type="button" id="mc-add-row" data-ui="add">+ Add Card</button>';
  html += '</fieldset>';
  html += '<script id="mc-data" type="application/json">' + JSON.stringify(cards).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderMetricCardsRows(container) {
  var dataEl = container.querySelector('#mc-data');
  var cards = [];
  try { cards = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#mc-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i] || {};
    html += '<div class="mc-row" data-ui="list-row">';
    html += '<input type="text" class="mc-title" value="' + escHtml(c.title || '') + '" placeholder="Label" data-ui="input grow">';
    html += metricSelect(c.metric || '', 'mc-metric-' + i);
    html += '<input type="text" class="mc-unit" value="' + escHtml(c.unit || '') + '" placeholder="Unit" data-ui="input unit">';
    html += '<button type="button" class="mc-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#mc-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ title: '', metric: '', unit: '' });
      dataEl.textContent = JSON.stringify(current);
      renderMetricCardsRows(container);
    };
  }
  container.querySelectorAll('.mc-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderMetricCardsRows(container);
    };
  });
}

/** Data Tables: column toggles */
function buildDataTableForm(block) {
  var cfg = block.config || {};
  var columns = cfg.columns || [];
  var allColFields = ['consumption_kwh','solar_kwh','battery_charge_kwh','battery_discharge_kwh','grid_import_kwh','grid_export_kwh'];
  var colLabels = {consumption_kwh:'Load (kWh)',solar_kwh:'Solar PV (kWh)',battery_charge_kwh:'Battery Charged (kWh)',battery_discharge_kwh:'Battery Discharged (kWh)',grid_import_kwh:'Grid Used (kWh)',grid_export_kwh:'Grid Exported (kWh)'};
  var enabledFields = {};
  columns.forEach(function(c) { enabledFields[c.field] = true; });
  // If no columns configured, all are enabled
  if (columns.length === 0) {
    allColFields.forEach(function(f) { enabledFields[f] = true; });
  }
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Columns</legend>';
  html += '<label data-ui="field">Title <input type="text" id="modal-table-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
  html += '<div data-ui="grid2">';
  for (var i = 0; i < allColFields.length; i++) {
    var f = allColFields[i];
    html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" class="col-toggle" data-field="' + f + '"' + (enabledFields[f] ? ' checked' : '') + '><span class="slider"></span></label><label data-ui="check">' + colLabels[f] + '</label></span>';
  }
  html += '</div></fieldset>';
  return html;
}

/** Text Card: content textarea */
function buildTextCardForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Content</legend>';
  html += '<textarea id="modal-text-content" data-ui="input textarea">' + escHtml(cfg.content || '') + '</textarea>';
  html += '</fieldset>';
  return html;
}

/** Text Metric: metric dropdown + optional friendly label + optional unit suffix */
function buildTextMetricForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Text Metric</legend>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Metric</span>';
  html += '<div data-ui="grow">' + metricSelect(cfg.metric || '', 'modal-metric-textmetric') + '</div>';
  html += '</div>';
  html += '<label data-ui="field">Label <input type="text" id="modal-textmetric-label" value="' + escHtml(cfg.label || '') + '" placeholder="Falls back to the metric key" data-ui="input"></label>';
  html += '<label data-ui="field">Unit suffix <input type="text" id="modal-textmetric-unit" value="' + escHtml(cfg.unit || '') + '" placeholder="Optional; appended to numeric values only" data-ui="input"></label>';
  html += '</fieldset>';
  return html;
}

/** Iframe Card: URL input */
function buildIframeCardForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Embed URL</legend>';
  html += '<label data-ui="label">URL <input type="text" id="modal-iframe-url" value="' + escHtml(cfg.url || '') + '" placeholder="https://..." data-ui="input"></label>';
  html += '</fieldset>';
  return html;
}

/** Battery Block: metrics map */
function buildBatteryBlockForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var slots = ['soc','voltage','current','power','temperature'];
  var labels = {soc:'SoC',voltage:'Voltage',current:'Current',power:'Power',temperature:'Temperature'};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Metrics Map</legend>';
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    html += '<div data-ui="row">';
    html += '<span data-ui="row-label">' + labels[s] + '</span>';
    html += '<div data-ui="grow">' + metricSelect(metrics[s] || '', 'modal-metric-batt-' + s) + '</div>';
    html += '</div>';
  }
  html += '<label data-ui="field">Title <input type="text" id="modal-batt-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
  html += '</fieldset>';
  return html;
}

/** Grid Card: grid_status metric */
function buildGridCardForm(block) {
  var cfg = block.config || {};
  var metrics = cfg.metrics || {};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Grid Status Config</legend>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Metric</span>';
  html += '<div data-ui="grow">' + metricSelect(metrics.grid_status || '', 'modal-metric-grid-status') + '</div>';
  html += '</div>';
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-showtimeline"' + (cfg.showTimeline !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-showtimeline">Show timeline</label></span>';
  html += '</fieldset>';
  return html;
}

/** Chart Power / Chart Energy: datasets */
function buildChartForm(block, showFill) {
  var cfg = block.config || {};
  var datasets = cfg.datasets || [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Options</legend>';
  html += '<div data-ui="grid2">';
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-chart-hidegrid"' + (cfg.hideGrid ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-chart-hidegrid">Hide Grid</label></span>';
  if (showFill) {
    html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-chart-fill"' + (cfg.fill !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-chart-fill">Fill Gradient</label></span>';
  }
  html += '</div></fieldset>';
  html += '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Datasets</legend>';
  html += '<div id="chart-rows"></div>';
  html += '<button type="button" id="chart-add-row" data-ui="add">+ Add Dataset</button>';
  html += '<label data-ui="field">Title <input type="text" id="modal-chart-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
  html += '</fieldset>';
  html += '<script id="chart-data" type="application/json">' + JSON.stringify(datasets).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderChartRows(container, showUnit, extraOptions) {
  var dataEl = container.querySelector('#chart-data');
  var datasets = [];
  try { datasets = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#chart-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < datasets.length; i++) {
    var d = datasets[i] || {};
    html += '<div class="chart-row" data-ui="list-row">';
    html += '<input type="text" class="chart-label" value="' + escHtml(d.label || '') + '" placeholder="Label" data-ui="input grow">';
    html += metricSelect(d.metric || '', 'chart-metric-' + i, extraOptions);
    if (showUnit) {
      html += '<input type="text" class="chart-unit" value="' + escHtml(d.unit || '') + '" placeholder="Unit" title="Measurement unit (e.g. %, kWh, kW, V, hours)" data-ui="input narrow">';
      html += '<input type="number" step="any" class="chart-scale" value="' + (Number.isFinite(Number(d.scale)) && d.scale !== null && d.scale !== '' ? Number(d.scale) : 1) + '" placeholder="Scale" title="Multiply values by this factor (e.g. 0.001 for W->kW)" data-ui="input narrow">';
    }
    html += '<label data-ui="inline-label"><span class="ed-visually-hidden">Color</span><input type="color" class="chart-color" value="' + escHtml(d.color || '#888888') + '" data-ui="swatch"></label>';
    html += '<button type="button" class="chart-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#chart-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ label: '', metric: '', color: '#888888' });
      dataEl.textContent = JSON.stringify(current);
      renderChartRows(container, showUnit, extraOptions);
    };
  }
  container.querySelectorAll('.chart-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderChartRows(container, showUnit, extraOptions);
    };
  });
}

/** Forecast blocks / weather / savings: simple title + metric if applicable */

// Card types with a per-card weather/forecast source selector (S3, AC1).
var WX_SOURCE_TYPES = ['weather-block', 'forecast-banner', 'forecast-info', 'forecast-sparkline', 'forecast-pvtoday'];
// Alert rule vocab (S3, AC15): metric in {temp,wind,precip,cloud}, op in {>,<}, max 4 rules.
var WX_ALERT_METRICS = ['temp', 'wind', 'precip', 'cloud'];
var WX_ALERT_OPS = ['>', '<'];
// REST field vocab for per-card rest_map (S5-editor): keys mirror the resolver
// rest_map (temp,humidity,wind,precip,cloud,ghi,description,pv_estimate); values are strings.
var REST_MAP_KEYS = ['temp', 'humidity', 'wind', 'precip', 'cloud', 'ghi', 'description', 'pv_estimate'];

/** Validate rest_map textarea text. Returns {ok, value, error}. Empty = null (key deleted on save). */
function validateRestMap(text) {
  var t = (text || '').trim();
  if (!t) return { ok: true, value: null };
  var obj = null;
  try { obj = JSON.parse(t); } catch (e) { return { ok: false, error: 'Field map must be a JSON object.' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'Field map must be a JSON object.' };
  var bad = Object.keys(obj).filter(function(k) { return REST_MAP_KEYS.indexOf(k) === -1; });
  if (bad.length) return { ok: false, error: 'Unknown field(s): ' + bad.join(', ') + '. Allowed: ' + REST_MAP_KEYS.join(', ') + '.' };
  var badVal = Object.keys(obj).filter(function(k) { return typeof obj[k] !== 'string'; });
  if (badVal.length) return { ok: false, error: 'Values must be strings (source field names). Bad key(s): ' + badVal.join(', ') + '.' };
  return { ok: true, value: obj };
}

/** Per-card REST field-map textarea (S5-editor). Shown only when source starts with rest:. */
function buildRestMapForm(cfg) {
  var rm = cfg.rest_map;
  var txt = '';
  if (typeof rm === 'string') txt = rm;
  else if (rm && typeof rm === 'object') txt = JSON.stringify(rm, null, 2);
  if (txt === '{}') txt = '';
  var visible = (cfg.source || '').indexOf('rest:') === 0;
  var html = '<div id="modal-restmap-wrap" style="margin-bottom:0.35rem;' + (visible ? '' : 'display:none;') + '">';
  html += '<label data-ui="field">REST field map (JSON object)';
  html += '<textarea id="modal-restmap" placeholder=\'{"temp": "temperature", "humidity": "humidity"}\' data-ui="input textarea mono">' + escHtml(txt) + '</textarea></label>';
  html += '<div id="modal-restmap-error" data-ui="error" style="display:none;"></div>';
  html += '</div>';
  return html;
}

/** Source dropdown shared by the 5 weather/forecast cards. Selected = cfg.source or auto. */
function weatherSourceSelect(cfg) {
  var sel = cfg.source || 'auto';
  var known = ['auto', 'solcast', 'open-meteo'];
  var isListedRest = sel.indexOf('rest:') === 0 && availableRestSources.indexOf(sel.slice(5)) !== -1;
  if (known.indexOf(sel) === -1 && !isListedRest) sel = 'auto';
  var html = '<div data-ui="row">';
  html += '<span data-ui="row-label">Source</span>';
  html += '<select id="modal-simple-source" data-ui="input grow">';
  html += '<option value="auto"' + (sel === 'auto' ? ' selected' : '') + '>Auto (default)</option>';
  html += '<option value="solcast"' + (sel === 'solcast' ? ' selected' : '') + '>Solcast</option>';
  html += '<option value="open-meteo"' + (sel === 'open-meteo' ? ' selected' : '') + '>Open-Meteo</option>';
  for (var i = 0; i < availableRestSources.length; i++) {
    var n = availableRestSources[i];
    var v = 'rest:' + n;
    html += '<option value="' + escHtml(v) + '"' + (v === sel ? ' selected' : '') + '>' + escHtml(n) + ' (REST)</option>';
  }
  html += '</select>';
  html += '</div>';
  return html;
}

// Weather card display toggles (all default ON: show everything the source provides).
var WX_DISPLAY_FIELDS = [['temp', 'Temperature'], ['feels_like', 'Feels Like'], ['humidity', 'Humidity'], ['wind', 'Wind'], ['desc', 'Description'], ['details', 'Rain / UV / Pressure / Cloud'], ['hourly', 'Hourly Strip'], ['sun', 'Sunrise / Sunset']];

/** Weather card display toggles + day count + mini-chart toggles (S3, AC7 AC12). */
function buildWeatherDisplayForm(cfg) {
  var disp = cfg.display || {};
  var charts = cfg.charts || {};
  var days = disp.days != null ? parseInt(disp.days, 10) : 6;
  if (!isFinite(days)) days = 6;
  days = Math.max(0, Math.min(6, days));
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Display</legend>';
  html += '<div data-ui="grid2">';
  var fields = WX_DISPLAY_FIELDS;
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i][0], label = fields[i][1], id = 'modal-wx-show-' + key;
    html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="' + id + '"' + (disp[key] !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="' + id + '">' + label + '</label></span>';
  }
  html += '</div>';
  html += '<label data-ui="field">Forecast Days <input type="number" id="modal-wx-days" min="0" max="6" step="1" value="' + days + '" data-ui="input"></label>';
  html += '</fieldset>';
  html += '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Charts</legend>';
  html += '<div data-ui="grid2">';
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-wx-chart-ghi"' + (charts.ghi !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-wx-chart-ghi">GHI Curve</label></span>';
  html += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-wx-chart-temp"' + (charts.temp === true ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-wx-chart-temp">Temp Curve</label></span>';
  html += '</div></fieldset>';
  return html;
}

/** Weather card alert-rules editor shell (S3, AC15). Rows rendered by renderWeatherAlertRows. */
function buildWeatherAlertsForm(cfg) {
  var alerts = Array.isArray(cfg.alerts) ? cfg.alerts : [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Alerts (max 4)</legend>';
  html += '<div id="weather-alert-rows"></div>';
  html += '<button type="button" id="weather-alert-add" data-ui="add">+ Add Alert</button>';
  html += '<script id="weather-alert-data" type="application/json">' + JSON.stringify(alerts).replace(/</g, '\\u003c') + '</script>';
  html += '</fieldset>';
  return html;
}

/** Render alert-rule rows (metric/op/value + remove); add capped at 4. */
function renderWeatherAlertRows(container) {
  var dataEl = container.querySelector('#weather-alert-data');
  var rowsEl = container.querySelector('#weather-alert-rows');
  if (!dataEl || !rowsEl) return;
  var alerts = [];
  try { alerts = JSON.parse(dataEl.textContent); } catch(e) {}
  if (!Array.isArray(alerts)) alerts = [];
  var html = '';
  for (var i = 0; i < alerts.length; i++) {
    var a = alerts[i] || {};
    html += '<div class="wx-alert-row" data-ui="list-row">';
    html += '<select class="wx-alert-metric" data-ui="input grow">';
    for (var m = 0; m < WX_ALERT_METRICS.length; m++) {
      html += '<option value="' + WX_ALERT_METRICS[m] + '"' + (a.metric === WX_ALERT_METRICS[m] ? ' selected' : '') + '>' + WX_ALERT_METRICS[m] + '</option>';
    }
    html += '</select>';
    html += '<select class="wx-alert-op" data-ui="input narrow">';
    for (var o = 0; o < WX_ALERT_OPS.length; o++) {
      html += '<option value="' + escHtml(WX_ALERT_OPS[o]) + '"' + (a.op === WX_ALERT_OPS[o] ? ' selected' : '') + '>' + escHtml(WX_ALERT_OPS[o]) + '</option>';
    }
    html += '</select>';
    html += '<input type="number" step="any" class="wx-alert-value" value="' + escHtml(a.value != null ? String(a.value) : '') + '" placeholder="value" data-ui="input grow">';
    html += '<button type="button" class="wx-alert-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;
  var addBtn = container.querySelector('#weather-alert-add');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      if (!Array.isArray(current)) current = [];
      if (current.length >= 4) return;
      current.push({ metric: 'temp', op: '>', value: '' });
      dataEl.textContent = JSON.stringify(current);
      renderWeatherAlertRows(container);
    };
  }
  rowsEl.querySelectorAll('.wx-alert-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      if (!Array.isArray(current)) current = [];
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderWeatherAlertRows(container);
    };
  });
}

function buildSimpleForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Config</legend>';

  if (block.type === 'savings-summary') {
    html += '<label data-ui="field">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
    html += '<div data-ui="row">';
    html += '<span data-ui="row-label">Metric</span>';
    html += '<div data-ui="grow">' + metricSelect(cfg.savings_metric || '', 'modal-simple-metric') + '</div>';
    html += '</div>';
  } else if (block.type === 'forecast-pvtoday') {
    html += '<label data-ui="field">Location Name <input type="text" id="modal-simple-title" value="' + escHtml(cfg.location_name || '') + '" data-ui="input"></label>';
    html += '<div data-ui="row">';
    html += '<span data-ui="row-label">Metric</span>';
    html += '<div data-ui="grow">' + metricSelect((cfg.metrics || {}).generated || '', 'modal-simple-metric') + '</div>';
    html += '</div>';
  } else if (block.type === 'weather-block') {
    html += '<label data-ui="field">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
  } else if (block.type === 'forecast-banner' || block.type === 'forecast-info' || block.type === 'forecast-sparkline') {
    html += '<label data-ui="field">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
    if (block.type !== 'forecast-sparkline') {
      var fcDays = parseInt(cfg.days, 10);
      if (!isFinite(fcDays)) fcDays = 3;
      html += '<label data-ui="field">Upcoming days shown <input type="number" id="modal-fc-days" min="1" max="6" step="1" value="' + Math.max(1, Math.min(6, fcDays)) + '" data-ui="input"></label>';
    }
  } else {
    html += '<label data-ui="field">Title <input type="text" id="modal-simple-title" value="' + escHtml(cfg.title || '') + '" data-ui="input"></label>';
  }

  if (WX_SOURCE_TYPES.indexOf(block.type) !== -1) {
    html += weatherSourceSelect(cfg);
    html += buildRestMapForm(cfg);
  }

  html += '</fieldset>';
  if (block.type === 'weather-block') {
    html += buildWeatherDisplayForm(cfg);
    html += buildWeatherAlertsForm(cfg);
  }
  return html;
}

/** Switch Block: entity metric, source, label, action, on/off icons + colors */
function buildSwitchBlockForm(block) {
  var cfg = block.config || {};
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">Toggle Switch Config</legend>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Entity</span>';
  html += '<div data-ui="grow">' + metricSelect(cfg.entity || '', 'modal-switch-entity') + '</div>';
  html += '</div>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Source</span>';
  html += '<input type="text" id="modal-switch-source" value="' + escHtml(cfg.source || 'ha') + '" placeholder="ha" data-ui="input grow">';
  html += '</div>';
  html += '<label data-ui="field">Label <input type="text" id="modal-switch-label" value="' + escHtml(cfg.label || '') + '" data-ui="input"></label>';
  html += '<label data-ui="field">Action <input type="text" id="modal-switch-action" value="' + escHtml(cfg.action || 'switch.toggle') + '" placeholder="switch.toggle" data-ui="input"></label>';
  html += '<div data-ui="grid2">';
  html += '<label data-ui="label">On Color <input type="color" id="modal-switch-oncolor" value="' + escHtml(cfg.onColor || '') + '" data-dirty="false" data-ui="color"></label>';
  html += '<label data-ui="label">Off Color <input type="color" id="modal-switch-offcolor" value="' + escHtml(cfg.offColor || '') + '" data-dirty="false" data-ui="color"></label>';
  html += '<label data-ui="label">On Icon <input type="text" id="modal-switch-onicon" value="' + escHtml(cfg.onIcon || '') + '" placeholder="🔆" data-ui="input"></label>';
  html += '<label data-ui="label">Off Icon <input type="text" id="modal-switch-officon" value="' + escHtml(cfg.offIcon || '') + '" placeholder="🔅" data-ui="input"></label>';
  html += '</div>';
  html += '</fieldset>';
  return html;
}

/** State Select Block: entity, source, label, action, display style, state-list editor */
function buildStateSelectForm(block) {
  var cfg = block.config || {};
  var states = Array.isArray(cfg.states) ? cfg.states : [];
  var html = '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">State Select Config</legend>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Entity</span>';
  html += '<div data-ui="grow">' + metricSelect(cfg.entity || '', 'modal-state-entity') + '</div>';
  html += '</div>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Source</span>';
  html += '<input type="text" id="modal-state-source" value="' + escHtml(cfg.source || 'ha') + '" placeholder="ha" data-ui="input grow">';
  html += '</div>';
  html += '<label data-ui="field">Label <input type="text" id="modal-state-label" value="' + escHtml(cfg.label || '') + '" data-ui="input"></label>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Action</span>';
  html += '<input type="text" id="modal-state-action" value="' + escHtml(cfg.action || 'select.select_option') + '" placeholder="select.select_option" data-ui="input grow">';
  html += '</div>';
  html += '<div data-ui="row">';
  html += '<span data-ui="row-label">Display</span>';
  html += '<select id="modal-state-displaystyle" data-ui="input grow">';
  html += '<option value="buttons"' + (cfg.displayStyle !== 'dropdown' ? ' selected' : '') + '>Button group</option>';
  html += '<option value="dropdown"' + (cfg.displayStyle === 'dropdown' ? ' selected' : '') + '>Dropdown</option>';
  html += '</select>';
  html += '</div>';
  html += '</fieldset>';
  html += '<fieldset data-ui="section">';
  html += '<legend data-ui="legend">States</legend>';
  html += '<div id="state-rows"></div>';
  html += '<button type="button" id="state-add-row" data-ui="add">+ Add State</button>';
  html += '</fieldset>';
  html += '<script id="state-data" type="application/json">' + JSON.stringify(states).replace(/</g, '\\u003c') + '</script>';
  return html;
}

function renderStateSelectRows(container) {
  var dataEl = container.querySelector('#state-data');
  var states = [];
  try { states = JSON.parse(dataEl.textContent); } catch(e) {}
  var rowsEl = container.querySelector('#state-rows');
  if (!rowsEl) return;
  var html = '';
  for (var i = 0; i < states.length; i++) {
    var st = states[i];
    var val = (st && typeof st === 'object') ? (st.value ?? '') : (st ?? '');
    var lbl = (st && typeof st === 'object' && st.label != null) ? st.label : val;
    var col = (st && typeof st === 'object' && st.color) ? st.color : '';
    html += '<div class="state-row" data-ui="list-row">';
    html += '<input type="text" class="state-value" value="' + escHtml(String(val)) + '" placeholder="value" data-ui="input grow">';
    html += '<input type="text" class="state-label" value="' + escHtml(String(lbl)) + '" placeholder="label" data-ui="input grow">';
    html += '<label data-ui="inline-label"><span class="ed-visually-hidden">Color</span><input type="color" class="state-color" value="' + escHtml(col || '#888888') + '" data-dirty="false" data-ui="swatch"></label>';
    html += '<button type="button" class="state-remove row-remove-btn" data-idx="' + i + '" aria-label="Remove">✕</button>';
    html += '</div>';
  }
  rowsEl.innerHTML = html;

  // Only persist a color if the user actually changed it
  rowsEl.querySelectorAll('.state-color').forEach(function(c) {
    c.addEventListener('input', function() { this.dataset.dirty = 'true'; }, { once: true });
  });

  rowsEl.querySelectorAll('.state-remove').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.idx);
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.splice(idx, 1);
      dataEl.textContent = JSON.stringify(current);
      renderStateSelectRows(container);
    };
  });

  var addBtn = container.querySelector('#state-add-row');
  if (addBtn) {
    addBtn.onclick = function() {
      var current = [];
      try { current = JSON.parse(dataEl.textContent); } catch(e) {}
      current.push({ value: '', label: '' });
      dataEl.textContent = JSON.stringify(current);
      renderStateSelectRows(container);
    };
  }
}

function buildConfigurableGaugeForm(block) {
  var c = block.config || {}, b = c.band || {}, g = c.graph || {};
  function field(key, label, value, type, attrs) {
    var id = 'cg-' + key.replace(/[^a-z0-9]/gi, '-');
    return '<label data-ui="field">' + label + ' <input id="' + id + '" type="' + (type || 'text') + '" value="' + escHtml(value == null ? '' : value) + '" ' + (attrs || 'data-ui="input"') + '></label>';
  }
  function select(key, label, value, choices) {
    return '<label data-ui="field">' + label + ' <select id="cg-' + key + '" data-ui="input">' + choices.map(function(x) { return '<option value="' + x[0] + '"' + (x[0] === value ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>';
  }
  function optionalColor(key, label, value) { return field(key, label, value, 'text', 'placeholder="Use theme default" data-ui="input"'); }
  function check(key, label, value) { return '<label><input id="cg-' + key + '" type="checkbox"' + (value ? ' checked' : '') + '> ' + label + '</label>'; }
  var h = '<fieldset data-ui="section"><legend data-ui="legend">Metric and readout</legend><label data-ui="field">Metric ' + metricSelect(c.metric || '', 'cg-metric') + '</label>';
  h += field('title','Title',c.title) + field('unit','Unit',c.unit) + field('min','Minimum',c.min == null ? 0 : c.min,'number','step="any" data-ui="input"') + field('max','Maximum',c.max == null ? 100 : c.max,'number','step="any" data-ui="input"');
  h += field('precision','Precision',c.precision == null ? 0 : c.precision,'number','min="0" max="6" data-ui="input"') + check('showReadout','Show readout',c.showReadout !== false) + field('readoutColor','Readout color',c.readoutColor,'text','placeholder="Use theme default" data-ui="input"') + field('readoutSize','Readout size',c.readoutSize == null ? 24 : c.readoutSize,'number');
  h += '</fieldset><fieldset data-ui="section"><legend data-ui="legend">Outer band</legend>' + check('band-show','Show band',b.show) + field('band-thickness','Thickness',b.thickness == null ? 8 : b.thickness,'number') + field('band-spacing','Spacing',b.spacing == null ? 3 : b.spacing,'number') + optionalColor('band-trackColor','Track color',b.trackColor);
  h += '<div id="cg-threshold-rows">' + (Array.isArray(b.thresholds) ? b.thresholds : []).map(function(t,i){return '<div data-ui="row" data-threshold-index="' + i + '"><label>Threshold ' + (i+1) + ' <input class="cg-threshold-value" type="number" step="any" value="' + escHtml(t.value) + '"></label><label>Color <input class="cg-threshold-color" type="text" placeholder="Use theme default" value="' + escHtml(t.color || '') + '"></label></div>';}).join('') + '</div><button type="button" id="cg-threshold-add" data-ui="add">Add threshold</button></fieldset>';
  h += '<fieldset data-ui="section"><legend data-ui="legend">Inner ring</legend>' + select('preset','Preset',c.preset || 'continuous',[['continuous','Continuous'],['segmented','Segmented']]) + select('style','Style',c.style || 'flat',[['flat','Flat'],['gradient','Gradient'],['glow','Glow']]);
  h += field('segmentCount','Segment count',c.segmentCount == null ? 12 : c.segmentCount,'number') + field('segmentGap','Segment gap',c.segmentGap == null ? 2 : c.segmentGap,'number') + field('segmentColors','Segment colors (comma-separated)',Array.isArray(c.segmentColors) ? c.segmentColors.join(', ') : '') + optionalColor('arcColor','Arc color',c.arcColor) + optionalColor('gradientEnd','Gradient end',c.gradientEnd) + field('arcThickness','Arc thickness',c.arcThickness == null ? 12 : c.arcThickness,'number') + optionalColor('trackColor','Track color',c.trackColor) + '</fieldset>';
  h += '<fieldset data-ui="section"><legend data-ui="legend">Geometry</legend>' + field('opening','Opening angle',c.opening == null ? 90 : c.opening,'number') + field('rotation','Rotation',c.rotation == null ? 0 : c.rotation,'number') + field('size','Gauge size',c.size == null ? 200 : c.size,'number') + '</fieldset>';
  h += '<fieldset data-ui="section"><legend data-ui="legend">Mini graph</legend>' + check('graph-show','Show graph',g.show) + '<label data-ui="field">Graph metric ' + metricSelect(g.metric || '', 'cg-graph-metric') + '</label>' + select('graph-window','History window',g.window || '1h',[['1h','1 hour'],['6h','6 hours'],['24h','24 hours'],['7d','7 days']]) + select('graph-mode','Graph style',g.mode || 'line',[['line','Line'],['area','Area']]);
  h += field('graph-thickness','Line thickness',g.thickness == null ? 2 : g.thickness,'number') + optionalColor('graph-color','Graph color',g.color) + field('graph-opacity','Fill opacity',g.opacity == null ? .2 : g.opacity,'number','min="0" max="1" step="0.05" data-ui="input"') + check('graph-marker','Endpoint marker',g.marker) + '</fieldset>';
  h += '<fieldset data-ui="section"><legend data-ui="legend">Card surface</legend>' + optionalColor('background','Background',c.background) + optionalColor('borderColor','Border color',c.borderColor) + field('borderWidth','Border width',c.borderWidth == null ? 0 : c.borderWidth,'number') + field('radius','Corner radius',c.radius == null ? 12 : c.radius,'number') + '</fieldset>';
  return h;
}

/** Main entry: build the settings form for a given block type */
function buildSettingsForm(block) {
  var type = block.type;
  var html = '';

  // Appearance fields live on the inspector's Style tab (buildAppearanceFields).

  // Type-specific fields
  switch (type) {
    case 'flow-card':
      html += buildFlowCardForm(block);
      break;
    case 'flow-card-2':
    case 'flow-card-square':
    case 'flow-card-square-2':
      html += buildSystemTopologyForm(block);
      break;
    case 'multi-value':
      html += buildMultiValueForm(block);
      break;
    case 'bar-gauge':
      html += buildBarGaugeForm(block);
      break;
    case 'bar-gauge-retro':
      html += buildBarGaugeRetroForm(block);
      break;
    case 'bar-single':
      html += buildBarSingleForm(block);
      break;
    case 'bar-stacked':
      html += buildBarStackedForm(block);
      break;
    case 'bar-threshold':
      html += buildBarThresholdForm(block);
      break;
    case 'configurable-gauge':
      html += buildConfigurableGaugeForm(block);
      break;
    case 'gauge-card':
    case 'half-gauge':
    case 'half-gauge-2':
      html += buildGaugeForm(block);
      break;
    case 'metric-cards':
      html += buildMetricCardsForm(block);
      break;
    case 'data-table-daily':
    case 'data-table-monthly':
      html += buildDataTableForm(block);
      break;
    case 'text-card':
      html += buildTextCardForm(block);
      break;
    case 'text-metric':
      html += buildTextMetricForm(block);
      break;
    case 'iframe-card':
      html += buildIframeCardForm(block);
      break;
    case 'battery-block':
      html += buildBatteryBlockForm(block);
      break;
    case 'grid-card':
      html += buildGridCardForm(block);
      break;
    case 'chart-power':
      html += buildChartForm(block, true);
      break;
    case 'chart-metric':
      html += buildChartForm(block, true);
      break;
    case 'chart-energy':
      html += buildChartForm(block, false);
      break;
    case 'switch-block':
      html += buildSwitchBlockForm(block);
      break;
    case 'state-select':
      html += buildStateSelectForm(block);
      break;
    default:
      // forecast-*, weather-block, savings-summary, forecast-pvtoday etc.
      html += buildSimpleForm(block);
      break;
  }

  return html;
}

/** Read all form values from the modal and update the block's config */
function readSettingsForm(block) {
  var config = Object.assign({}, block.config || {});
  if (block.type === 'configurable-gauge') {
    var minField = document.getElementById('cg-min'), maxField = document.getElementById('cg-max');
    var minRaw = minField ? String(minField.value).trim() : String(config.min == null ? 0 : config.min).trim();
    var maxRaw = maxField ? String(maxField.value).trim() : String(config.max == null ? 100 : config.max).trim();
    var minValue = minRaw === '' ? NaN : Number(minRaw);
    var maxValue = maxRaw === '' ? NaN : Number(maxRaw);
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue >= maxValue) return 'Minimum and maximum must be finite numbers, and minimum must be less than maximum.';
  }
  // Common appearance
  config.enabled = document.getElementById('modal-enabled')?.checked !== false;
  config.transparent = document.getElementById('modal-transparent')?.checked || false;
  config.bgColor = document.getElementById('modal-bgcolor')?.value || '';
  if (config.bgColor === '#000000' && document.getElementById('modal-bgcolor')?.dataset.dirty !== 'true') config.bgColor = '';
  config.fontColor = document.getElementById('modal-fontcolor')?.value || '';
  if (config.fontColor === '#000000' && document.getElementById('modal-fontcolor')?.dataset.dirty !== 'true') config.fontColor = '';
  config.fontSize = document.getElementById('modal-fontsize')?.value || '';

  // Apply common fields to block
  block.enabled = config.enabled;
  block.transparent = config.transparent;
  block.bgColor = config.bgColor;
  block.fontColor = config.fontColor;
  block.fontSize = config.fontSize;

  var type = block.type;

  switch (type) {
    case 'flow-card': {
      var slots = ['solar','battery_soc','battery_charge','battery_discharge','consumption','grid_import','grid_export'];
      var metrics = {};
      slots.forEach(function(s) {
        var el = document.getElementById('modal-metric-' + s);
        if (el) metrics[s] = el.value || s;
      });
      block.metrics = metrics;
      config.metrics = metrics;
      config.showGauge = document.getElementById('modal-showgauge')?.checked !== false;
      break;
    }
    case 'flow-card-2':
    case 'flow-card-square':
    case 'flow-card-square-2': {
      var fslots = ['solar','grid_import','battery_charge','battery_soc','consumption','battery_discharge','grid_export'];
      var fmetrics = {};
      fslots.forEach(function(s) {
        var el = document.getElementById('modal-metric-' + s);
        if (el) fmetrics[s] = el.value || s;
      });
      block.metrics = fmetrics;
      config.metrics = fmetrics;
      config.inverter_image = document.getElementById('modal-inverter-image')?.value || '';
      break;
    }
    case 'multi-value': {
      var mvData = document.getElementById('mv-data');
      var mvRows = [];
      try { mvRows = JSON.parse(mvData.textContent); } catch(e) {}
      // Read live inputs to update labels/units before saving
      var labelEls = document.querySelectorAll('.mv-label');
      var unitEls = document.querySelectorAll('.mv-unit');
      for (var i = 0; i < mvRows.length; i++) {
        if (labelEls[i]) mvRows[i].label = labelEls[i].value;
        var msel = document.getElementById('mv-metric-' + i);
        if (msel) mvRows[i].metric = msel.value;
        if (unitEls[i]) mvRows[i].unit = unitEls[i].value;
      }
      block.metrics = mvRows;
      config.metrics = mvRows;
      break;
    }
    case 'bar-gauge': {
      var bgData = document.getElementById('bg-data');
      var bgRows = [];
      try { bgRows = JSON.parse(bgData.textContent); } catch(e) {}
      var allLabels = document.querySelectorAll('.bg-label');
      var allUnits = document.querySelectorAll('.bg-unit');
      var allMins = document.querySelectorAll('.bg-min');
      var allMaxs = document.querySelectorAll('.bg-max');
      var allColors = document.querySelectorAll('.bg-color');
      var allGrads = document.querySelectorAll('.bg-gradient');
      for (var j = 0; j < bgRows.length; j++) {
        var labelEl = allLabels[j];
        if (labelEl) bgRows[j].label = labelEl.value;
        var msel2 = document.getElementById('bg-metric-' + j);
        if (msel2) bgRows[j].metric = msel2.value;
        var uel = allUnits[j];
        if (uel) bgRows[j].unit = uel.value;
        var minel = allMins[j];
        if (minel) bgRows[j].min = parseFloat(minel.value) || 0;
        var maxel = allMaxs[j];
        if (maxel) bgRows[j].max = parseFloat(maxel.value) || 100;
        var cel = allColors[j];
        if (cel) bgRows[j].color = cel.value;
        var gel = allGrads[j];
        if (gel) bgRows[j].gradient = gel.value;
      }
      block.metrics = bgRows;
      config.metrics = bgRows;
      break;
    }
    case 'bar-gauge-retro': {
      var bgrData = document.getElementById('bgr-data');
      var bgrRows = [];
      try { bgrRows = JSON.parse(bgrData.textContent); } catch(e) {}
      var allBgrLabels = document.querySelectorAll('.bgr-label');
      var allBgrUnits = document.querySelectorAll('.bgr-unit');
      var allBgrMins = document.querySelectorAll('.bgr-min');
      var allBgrMaxs = document.querySelectorAll('.bgr-max');
      var allBgrSegs = document.querySelectorAll('.bgr-segments');
      var allBgrColors = document.querySelectorAll('.bgr-color');
      var allBgrGrads = document.querySelectorAll('.bgr-gradient');
      for (var k = 0; k < bgrRows.length; k++) {
        var labelEl2 = allBgrLabels[k];
        if (labelEl2) bgrRows[k].label = labelEl2.value;
        var msel3 = document.getElementById('bgr-metric-' + k);
        if (msel3) bgrRows[k].metric = msel3.value;
        var uel2 = allBgrUnits[k];
        if (uel2) bgrRows[k].unit = uel2.value;
        var minel2 = allBgrMins[k];
        if (minel2) bgrRows[k].min = parseFloat(minel2.value) || 0;
        var maxel2 = allBgrMaxs[k];
        if (maxel2) bgrRows[k].max = parseFloat(maxel2.value) || 100;
        var selEl = allBgrSegs[k];
        if (selEl) bgrRows[k].segments = parseInt(selEl.value) || 10;
        var cel2 = allBgrColors[k];
        if (cel2) bgrRows[k].color = cel2.value;
        var gel2 = allBgrGrads[k];
        if (gel2) bgrRows[k].gradient = gel2.value;
      }
      block.metrics = bgrRows;
      config.metrics = bgrRows;
      break;
    }
    case 'bar-single': {
      config.metric = document.getElementById('modal-bar-metric')?.value || '';
      var barRangeEl = document.getElementById('modal-bar-range');
      var barRangeVal = barRangeEl ? barRangeEl.value : '';
      config.range = (barRangeVal === '24h' || barRangeVal === '7d') ? barRangeVal : '24h';
      var barBucketEl = document.getElementById('modal-bar-bucket');
      var barBucketVal = barBucketEl ? barBucketEl.value : '';
      config.bucket = (barBucketVal === '15m' || barBucketVal === '1h' || barBucketVal === '1d') ? barBucketVal : '1h';
      var barModeEl = document.getElementById('modal-bar-bandmode');
      config.bandMode = (barModeEl && barModeEl.value === 'fixed') ? 'fixed' : 'auto';
      var barBandsData = document.getElementById('bar-bands-data');
      var barBandsRows = [];
      try { barBandsRows = JSON.parse(barBandsData.textContent); } catch(e) {}
      var allBandTos = document.querySelectorAll('.bar-band-to');
      var allBandColors = document.querySelectorAll('.bar-band-color');
      var bandsOut = [];
      for (var bi = 0; bi < barBandsRows.length; bi++) {
        var toVal = allBandTos[bi] ? parseFloat(allBandTos[bi].value) : NaN;
        if (!isFinite(toVal)) continue;
        var colVal = allBandColors[bi] ? allBandColors[bi].value : '';
        bandsOut.push({ to: toVal, color: colVal || BAR_SINGLE_WARM[bi % BAR_SINGLE_WARM.length] });
      }
      if (!bandsOut.length) {
        bandsOut = BAR_SINGLE_WARM.map(function(c, i) { return { to: (i + 1) * 25, color: c }; });
      }
      config.bands = bandsOut;
      break;
    }
    case 'bar-stacked': {
      var bsRangeEl = document.getElementById('modal-bs-range');
      var bsRangeVal = bsRangeEl ? bsRangeEl.value : '';
      config.range = (bsRangeVal === '24h' || bsRangeVal === '7d') ? bsRangeVal : '24h';
      var bsBucketEl = document.getElementById('modal-bs-bucket');
      var bsBucketVal = bsBucketEl ? bsBucketEl.value : '';
      config.bucket = (bsBucketVal === '15m' || bsBucketVal === '1h' || bsBucketVal === '1d') ? bsBucketVal : '1h';
      var bsAggEl = document.getElementById('modal-bs-agg');
      var bsAggVal = bsAggEl ? bsAggEl.value : '';
      config.agg = (['avg', 'sum', 'min', 'max', 'last'].indexOf(bsAggVal) !== -1) ? bsAggVal : 'avg';
      var bsData = document.getElementById('bs-data');
      var bsRows = [];
      try { bsRows = JSON.parse(bsData.textContent); } catch(e) {}
      var bsLabels = document.querySelectorAll('.bs-label');
      var bsColors = document.querySelectorAll('.bs-color');
      var bsOut = [];
      for (var bsi = 0; bsi < bsRows.length; bsi++) {
        var bsMetricEl = document.getElementById('bs-metric-' + bsi);
        var bsMetric = bsMetricEl ? bsMetricEl.value : '';
        if (!bsMetric) continue;
        var bsLabel = bsLabels[bsi] ? bsLabels[bsi].value : '';
        var bsColor = bsColors[bsi] ? bsColors[bsi].value : '';
        bsOut.push({ label: bsLabel || bsMetric, metric: bsMetric, color: bsColor || BAR_STACKED_WARM[bsOut.length % BAR_STACKED_WARM.length] });
      }
      block.metrics = bsOut;
      config.metrics = bsOut;
      break;
    }
    case 'bar-threshold': {
      config.metric = document.getElementById('modal-bt-metric')?.value || '';
      var btRangeEl = document.getElementById('modal-bt-range');
      var btRangeVal = btRangeEl ? btRangeEl.value : '';
      config.range = (btRangeVal === '24h' || btRangeVal === '7d') ? btRangeVal : '24h';
      var btBucketEl = document.getElementById('modal-bt-bucket');
      var btBucketVal = btBucketEl ? btBucketEl.value : '';
      config.bucket = (btBucketVal === '15m' || btBucketVal === '1h' || btBucketVal === '1d') ? btBucketVal : '1h';
      var btAggEl = document.getElementById('modal-bt-valueagg');
      var btAggVal = btAggEl ? btAggEl.value : '';
      config.valueAgg = (btAggVal === 'avg') ? 'avg' : 'last';
      var btModeEl = document.getElementById('modal-bt-bandmode');
      config.bandMode = (btModeEl && btModeEl.value === 'fixed') ? 'fixed' : 'auto';
      var btBandsData = document.getElementById('bt-bands-data');
      var btBandsRows = [];
      try { btBandsRows = JSON.parse(btBandsData.textContent); } catch(e) {}
      var allBtTos = document.querySelectorAll('.bt-band-to');
      var allBtColors = document.querySelectorAll('.bt-band-color');
      var btBandsOut = [];
      for (var bti = 0; bti < btBandsRows.length; bti++) {
        var btToVal = allBtTos[bti] ? parseFloat(allBtTos[bti].value) : NaN;
        if (!isFinite(btToVal)) continue;
        var btColVal = allBtColors[bti] ? allBtColors[bti].value : '';
        btBandsOut.push({ to: btToVal, color: btColVal || BAR_THRESHOLD_WARM[bti % BAR_THRESHOLD_WARM.length] });
      }
      if (!btBandsOut.length) btBandsOut = BAR_THRESHOLD_WARM.map(function(c, i) { return { to: (i + 1) * 25, color: c }; });
      config.bands = btBandsOut;
      break;
    }
    case 'configurable-gauge': {
      function val(key) { var el = document.getElementById('cg-' + key); return el ? el.value : ''; }
      function num(key, fallback) { var n = Number(val(key)); return Number.isFinite(n) ? n : fallback; }
      function checked(key) { var el = document.getElementById('cg-' + key); return !!(el && el.checked); }
      config.metric = val('metric'); config.title = val('title'); config.unit = val('unit'); config.min = Number(val('min')); config.max = Number(val('max'));
      config.precision = num('precision', 0); config.showReadout = checked('showReadout'); config.readoutColor = val('readoutColor'); config.readoutSize = num('readoutSize', 24);
      var thresholdRows = document.querySelectorAll('#cg-threshold-rows [data-ui="row"]');
      config.band = Object.assign({}, config.band || {}, { show: checked('band-show'), thickness: num('band-thickness', 8), spacing: num('band-spacing', 3), trackColor: val('band-trackColor'), thresholds: Array.from(thresholdRows).map(function(row) { var index = row.getAttribute('data-threshold-index'); var prior = index == null ? {} : ((config.band && config.band.thresholds || [])[Number(index)] || {}); var rawValue = row.querySelector('.cg-threshold-value').value; return Object.assign({}, prior, { value: rawValue.trim() === '' ? NaN : Number(rawValue), color: row.querySelector('.cg-threshold-color').value }); }).filter(function(t) { return Number.isFinite(t.value); }) });
      config.preset = val('preset'); config.segmentCount = num('segmentCount', 12); config.segmentGap = num('segmentGap', 2); config.segmentColors = val('segmentColors').split(',').map(function(x) { return x.trim(); }).filter(Boolean);
      config.style = val('style'); config.arcColor = val('arcColor'); config.gradientEnd = val('gradientEnd'); config.arcThickness = num('arcThickness', 12); config.trackColor = val('trackColor');
      config.opening = num('opening', 90); config.rotation = num('rotation', 0); config.size = num('size', 200);
      config.graph = Object.assign({}, config.graph || {}, { show: checked('graph-show'), metric: val('graph-metric'), window: val('graph-window'), mode: val('graph-mode'), thickness: num('graph-thickness', 2), color: val('graph-color'), opacity: num('graph-opacity', .2), marker: checked('graph-marker') });
      config.background = val('background'); config.borderColor = val('borderColor'); config.borderWidth = num('borderWidth', 0); config.radius = num('radius', 12);
      break;
    }
    case 'gauge-card':
    case 'half-gauge':
    case 'half-gauge-2': {
      config.metric = document.getElementById('modal-metric-gauge')?.value || '';
      config.title = document.getElementById('modal-gauge-title')?.value || '';
      config.min = parseFloat(document.getElementById('modal-gauge-min')?.value) || 0;
      config.max = parseFloat(document.getElementById('modal-gauge-max')?.value) || 100;
      config.color = document.getElementById('modal-gauge-color')?.value || '#f59e0b';
      break;
    }
    case 'metric-cards': {
      var mcData = document.getElementById('mc-data');
      var mcRows = [];
      try { mcRows = JSON.parse(mcData.textContent); } catch(e) {}
      var allMcTitles = document.querySelectorAll('.mc-title');
      var allMcUnits = document.querySelectorAll('.mc-unit');
      for (var m = 0; m < mcRows.length; m++) {
        var tEl = allMcTitles[m];
        if (tEl) mcRows[m].title = tEl.value;
        var mmel = document.getElementById('mc-metric-' + m);
        if (mmel) mcRows[m].metric = mmel.value;
        var uel3 = allMcUnits[m];
        if (uel3) mcRows[m].unit = uel3.value;
      }
      block.cards = mcRows;
      break;
    }
    case 'data-table-daily':
    case 'data-table-monthly': {
      var toggles = document.querySelectorAll('.col-toggle');
      var cols = [];
      toggles.forEach(function(t) {
        if (t.checked) {
          var f = t.dataset.field;
          var labels = {consumption_kwh:'Load (kWh)',solar_kwh:'Solar PV (kWh)',battery_charge_kwh:'Battery Charged (kWh)',battery_discharge_kwh:'Battery Discharged (kWh)',grid_import_kwh:'Grid Used (kWh)',grid_export_kwh:'Grid Exported (kWh)'};
          cols.push({ field: f, label: labels[f] || f });
        }
      });
      block.columns = cols;
      config.columns = cols;
      config.title = document.getElementById('modal-table-title')?.value || '';
      break;
    }
    case 'text-card': {
      config.content = document.getElementById('modal-text-content')?.value || '';
      break;
    }
    case 'text-metric': {
      config.metric = document.getElementById('modal-metric-textmetric')?.value || '';
      config.label = document.getElementById('modal-textmetric-label')?.value || '';
      config.unit = document.getElementById('modal-textmetric-unit')?.value || '';
      break;
    }
    case 'iframe-card': {
      config.url = document.getElementById('modal-iframe-url')?.value || '';
      break;
    }
    case 'battery-block': {
      var bslots = ['soc','voltage','current','power','temperature'];
      var bmetrics = {};
      bslots.forEach(function(s) {
        var el = document.getElementById('modal-metric-batt-' + s);
        if (el) bmetrics[s] = el.value || '';
      });
      block.metrics = bmetrics;
      config.metrics = bmetrics;
      config.title = document.getElementById('modal-batt-title')?.value || '';
      break;
    }
    case 'grid-card': {
      config.metrics = config.metrics || {};
      config.metrics.grid_status = document.getElementById('modal-metric-grid-status')?.value || '';
      config.showTimeline = document.getElementById('modal-showtimeline')?.checked !== false;
      break;
    }
    case 'chart-power':
    case 'chart-energy':
    case 'chart-metric': {
      config.hideGrid = document.getElementById('modal-chart-hidegrid')?.checked || false;
      config.fill = document.getElementById('modal-chart-fill')?.checked !== false;
      var chData = document.getElementById('chart-data');
      var chRows = [];
      try { chRows = JSON.parse(chData.textContent); } catch(e) {}
      var allChartLabels = document.querySelectorAll('.chart-label');
      var allChartColors = document.querySelectorAll('.chart-color');
      for (var c = 0; c < chRows.length; c++) {
        var lEl = allChartLabels[c];
        if (lEl) chRows[c].label = lEl.value;
        var cmel = document.getElementById('chart-metric-' + c);
        if (cmel) chRows[c].metric = cmel.value;
        var ccel = allChartColors[c];
        if (ccel) chRows[c].color = ccel.value;
        var uels = document.querySelectorAll('.chart-unit'); if (uels[c]) chRows[c].unit = uels[c].value;
        var sels = document.querySelectorAll('.chart-scale'); if (sels[c]) chRows[c].scale = parseFloat(sels[c].value);
      }
      config.datasets = chRows;
      config.title = document.getElementById('modal-chart-title')?.value || '';
      break;
    }
    case 'switch-block': {
      config.entity = document.getElementById('modal-switch-entity')?.value || '';
      config.source = document.getElementById('modal-switch-source')?.value || 'ha';
      config.label = document.getElementById('modal-switch-label')?.value || '';
      config.action = document.getElementById('modal-switch-action')?.value || 'switch.toggle';
      var ocEl = document.getElementById('modal-switch-oncolor');
      config.onColor = ocEl?.value || '';
      if (config.onColor === '#000000' && ocEl?.dataset.dirty !== 'true') config.onColor = '';
      var ofEl = document.getElementById('modal-switch-offcolor');
      config.offColor = ofEl?.value || '';
      if (config.offColor === '#000000' && ofEl?.dataset.dirty !== 'true') config.offColor = '';
      config.onIcon = document.getElementById('modal-switch-onicon')?.value || '';
      config.offIcon = document.getElementById('modal-switch-officon')?.value || '';
      break;
    }
    case 'state-select': {
      config.entity = document.getElementById('modal-state-entity')?.value || '';
      config.source = document.getElementById('modal-state-source')?.value || 'ha';
      config.label = document.getElementById('modal-state-label')?.value || '';
      config.action = document.getElementById('modal-state-action')?.value || '';
      config.displayStyle = document.getElementById('modal-state-displaystyle')?.value || 'buttons';
      var stData = document.getElementById('state-data');
      var stRows = [];
      try { stRows = JSON.parse(stData.textContent); } catch(e) {}
      var allVals = document.querySelectorAll('.state-value');
      var allLbls = document.querySelectorAll('.state-label');
      var allCols = document.querySelectorAll('.state-color');
      var outStates = [];
      for (var s = 0; s < stRows.length; s++) {
        var vEl = allVals[s];
        if (!vEl) continue;
        var rowVal = vEl.value;
        var rowLbl = allLbls[s] ? allLbls[s].value : rowVal;
        if (!rowVal && !rowLbl) continue;
        var out = { value: rowVal, label: rowLbl };
        var colEl = allCols[s];
        if (colEl && colEl.dataset.dirty === 'true' && colEl.value) out.color = colEl.value;
        outStates.push(out);
      }
      config.states = outStates;
      break;
    }
    default: {
      // Simple blocks: forecast, savings, weather, pv today
      var titleEl = document.getElementById('modal-simple-title');
      if (titleEl) {
        if (type === 'forecast-pvtoday') config.location_name = titleEl.value;
        else config.title = titleEl.value;
      }
      var metEl = document.getElementById('modal-simple-metric');
      if (metEl) {
        if (type === 'savings-summary') config.savings_metric = metEl.value;
        else if (type === 'forecast-pvtoday') {
          config.metrics = config.metrics || {};
          config.metrics.generated = metEl.value;
        }
      }
      // S3: per-card weather/forecast source. auto = unset (delete key);
      // explicit valid pick persisted; deleted rest: source preserved (T7).
      var srcEl = document.getElementById('modal-simple-source');
      if (srcEl && WX_SOURCE_TYPES.indexOf(type) !== -1) {
        var priorSource = config.source;
        var sv = srcEl.value || 'auto';
        var okRest = sv.indexOf('rest:') === 0 && availableRestSources.indexOf(sv.slice(5)) !== -1;
        if (sv === 'auto') {
          if (priorSource && priorSource.indexOf('rest:') === 0 && availableRestSources.indexOf(priorSource.slice(5)) === -1) config.source = priorSource;
          else delete config.source;
        } else if (sv === 'solcast' || sv === 'open-meteo' || okRest) {
          config.source = sv;
        }
      }
      // S5-editor: per-card rest_map for rest: sources. Stored as an object on
      // config.rest_map (same shape as S3 alerts/charts); empty textarea or
      // non-rest source deletes the key. Invalid blocks save with inline error.
      if (WX_SOURCE_TYPES.indexOf(type) !== -1) {
        var curSrc = config.source || '';
        if (curSrc.indexOf('rest:') === 0) {
          var rmEl = document.getElementById('modal-restmap');
          var rmRes = validateRestMap(rmEl ? rmEl.value : '');
          if (!rmRes.ok) {
            var rmErrEl = document.getElementById('modal-restmap-error');
            if (rmErrEl) { rmErrEl.textContent = rmRes.error; rmErrEl.style.display = 'block'; }
            return rmRes.error;
          }
          if (rmRes.value && Object.keys(rmRes.value).length) config.rest_map = rmRes.value;
          else delete config.rest_map;
        } else {
          delete config.rest_map;
        }
      }
      var fcDaysEl = document.getElementById('modal-fc-days');
      if (fcDaysEl && (type === 'forecast-banner' || type === 'forecast-info')) {
        var fd = parseInt(fcDaysEl.value, 10);
        config.days = isFinite(fd) ? Math.max(1, Math.min(6, fd)) : 3;
      }
      // S3: weather-block display/charts/alerts, validated.
      if (type === 'weather-block') {
        var disp = {};
        for (var di = 0; di < WX_DISPLAY_FIELDS.length; di++) {
          var dk = WX_DISPLAY_FIELDS[di][0];
          var dcb = document.getElementById('modal-wx-show-' + dk);
          disp[dk] = dcb ? !!dcb.checked : true;
        }
        var daysEl = document.getElementById('modal-wx-days');
        var wdays = daysEl ? parseInt(daysEl.value, 10) : 6;
        if (!isFinite(wdays)) wdays = 6;
        disp.days = Math.max(0, Math.min(6, wdays));
        config.display = disp;
        var ghiEl = document.getElementById('modal-wx-chart-ghi');
        var tmpEl = document.getElementById('modal-wx-chart-temp');
        config.charts = { ghi: ghiEl ? !!ghiEl.checked : true, temp: tmpEl ? !!tmpEl.checked : false };
        var mEls = document.querySelectorAll('.wx-alert-metric');
        var oEls = document.querySelectorAll('.wx-alert-op');
        var vEls = document.querySelectorAll('.wx-alert-value');
        var alertsOut = [];
        for (var ai = 0; ai < mEls.length && alertsOut.length < 4; ai++) {
          var am = mEls[ai] ? mEls[ai].value : '';
          var ao = oEls[ai] ? oEls[ai].value : '';
          var av = vEls[ai] ? parseFloat(vEls[ai].value) : NaN;
          if (WX_ALERT_METRICS.indexOf(am) === -1) continue;
          if (WX_ALERT_OPS.indexOf(ao) === -1) continue;
          if (!isFinite(av)) continue;
          alertsOut.push({ metric: am, op: ao, value: av });
        }
        config.alerts = alertsOut;
      }
      break;
    }
  }

  block.config = config;
  return null;
}

// ── Block content on the grid ────────────────────────────────────────────

var FORECAST_TYPES = ['forecast-banner', 'forecast-info', 'forecast-sparkline', 'weather-block'];

/** Apply a block's saved styling to its rendered content (shared with the dashboard). */
function applyBlockStyling(content, block) { applyBlockStyle(content, block); }

/** Render a block's component, or null when its type is unknown. */
function buildBlockContent(block) {
  var builder = BLOCK_BUILDERS.get(block.type);
  if (typeof builder !== 'function') return null;
  var content;
  try {
    content = builder(block);
  } catch (e) {
    console.error('Block render failed:', block.type, block.id, e);
    content = document.createElement('div');
    content.className = 'blk-placeholder';
    content.textContent = "This block couldn't be drawn in the editor.";
    return content;
  }
  if (!content) return null;
  // Forecast blocks start hidden (display:none) while waiting for data. In the
  // editor, show them (or a labelled stub) so people can see where they sit.
  if (FORECAST_TYPES.indexOf(block.type) !== -1) {
    content.style.display = '';
    if (!content.querySelector('.fc-body, .wx-body, canvas')) {
      content.innerHTML = '';
      var stub = document.createElement('div');
      stub.className = 'blk-placeholder';
      stub.textContent = blockInfo(block.type).name;
      content.appendChild(stub);
    }
  }
  applyBlockStyling(content, block);
  return content;
}

function fillGridItemContent(inner, block) {
  var info = blockInfo(block.type);
  var known = BLOCK_BUILDERS.has(block.type);
  var hidden = block.enabled === false;

  inner.querySelectorAll('.blk-body, .blk-label, .blk-badge').forEach(function(el) { el.remove(); });
  inner.classList.toggle('is-hidden-block', hidden);
  inner.classList.toggle('is-unknown-block', !known);
  inner.setAttribute('aria-label', info.name + (hidden ? ', hidden on dashboard' : '') + (block.id === selectedBlockId ? ', selected' : ''));

  var label = document.createElement('span');
  label.className = 'blk-label';
  label.textContent = info.name;
  inner.insertBefore(label, inner.firstChild);

  var body = document.createElement('div');
  body.className = 'blk-body';
  var content = known ? buildBlockContent(block) : null;
  if (!content) {
    content = document.createElement('div');
    content.className = 'blk-placeholder';
    content.textContent = known ? info.name : 'Unknown block type "' + block.type + '". It isn\'t shown on the dashboard.';
  }
  // Lay the card out at its dashboard size, then shrink it to fit (see
  // applyPreviewScale), so it looks the way it will on the dashboard.
  var frame = document.createElement('div');
  frame.className = 'dashboard-block blk-scale';
  frame.dataset.blockId = block.id;
  frame.appendChild(content);
  body.appendChild(frame);
  inner.appendChild(body);

  if (hidden) {
    var badge = document.createElement('span');
    badge.className = 'blk-badge';
    badge.innerHTML = icon('eyeOff', 14) + '<span>Hidden on dashboard</span>';
    inner.appendChild(badge);
  }
}

/**
 * Build a single grid-stack-item DOM element for a block definition.
 * @param {object} block - block config {id, type, gridX, gridY, gridW, gridH, ...}
 * @returns {HTMLElement} the grid-stack-item element
 */
function buildGridItem(block) {
  if (!block.id) block.id = newBlockId();
  var info = blockInfo(block.type);
  var item = document.createElement('div');
  item.className = 'grid-stack-item';
  item.dataset.blockId = block.id;
  item.dataset.blockType = block.type;
  item.setAttribute('gs-x', block.gridX ?? 0);
  item.setAttribute('gs-y', block.gridY ?? 0);
  item.setAttribute('gs-w', block.gridW ?? block.colSpan ?? info.w);
  item.setAttribute('gs-h', block.gridH ?? Math.max(1, Math.round((block.rowSpan ?? 200) / CELL_HEIGHT)));
  item.setAttribute('gs-min-w', 1);
  item.setAttribute('gs-min-h', 1);

  var inner = document.createElement('div');
  inner.className = 'grid-stack-item-content';
  inner.tabIndex = 0;
  inner.setAttribute('role', 'group');
  fillGridItemContent(inner, block);
  item.appendChild(inner);
  return item;
}

/** Redraw a block on the grid after its settings change. */
function refreshGridItem(block) {
  var el = gridItemEl(block.id);
  if (!el) return;
  var inner = el.querySelector('.grid-stack-item-content');
  if (inner) fillGridItemContent(inner, block);
  schedulePreview();
}

function updateEmptyState() {
  var tab = currentTab();
  $('empty-state').hidden = !!(tab && tab.layout.length);
}

// ── Preview scale ────────────────────────────────────────────────────────
// The canvas is narrower than the dashboard, and cards are laid out for the
// dashboard's width. Rather than squeezing them, the whole layout is drawn as
// a scaled-down dashboard: rows and gaps shrink by the same factor as the
// columns, and each card is laid out at full size and scaled with CSS.

// GRID_MARGIN applies to each side of a block, so blocks sit 2 × GRID_MARGIN apart,
// the same as the dashboard (GAP in dashboard.js).
var DASHBOARD_MAX_WIDTH = 1400, DASHBOARD_PAGE_PADDING = 32, GRID_MARGIN = 1;
var previewScale = 1;

/** Width the dashboard's block area has in this browser window. */
function dashboardWidth() {
  return Math.min(DASHBOARD_MAX_WIDTH, Math.max(320, window.innerWidth - DASHBOARD_PAGE_PADDING));
}

function applyPreviewScale() {
  var el = $('grid');
  if (!el || !el.clientWidth) return;
  var k = Math.min(1, el.clientWidth / dashboardWidth());
  k = Math.round(k * 1000) / 1000;
  el.style.setProperty('--pv-scale', String(k));
  if (k === previewScale && grid && grid.getCellHeight() === CELL_HEIGHT * k) return;
  previewScale = k;
  if (grid) {
    grid.batchUpdate();
    grid.margin(GRID_MARGIN * k);
    grid.cellHeight(CELL_HEIGHT * k);
    grid.batchUpdate(false);
  }
}

// ── Live previews ────────────────────────────────────────────────────────
// Blocks on the grid show real data: the same dashboard state and the same
// card updaters the dashboard uses, refreshed every 30 seconds and right
// after a block is added or its settings change.

var previewState = null;
var previewTimer = null;
var CHART_TYPES = ['chart-power', 'chart-energy', 'chart-metric'];

function previewTypes() {
  var tab = currentTab();
  return new Set(tab ? tab.layout.map(function(b) { return b.type; }) : []);
}

function applyPreviews() {
  if (!previewState || !grid) return;
  var types = previewTypes();
  var run = function() {
    try { updateCards(previewState, types); } catch (e) { console.warn('Preview update failed:', e); }
  };
  if (CHART_TYPES.some(function(t) { return types.has(t); })) {
    ensureChartJS().then(function() {
      initPowerChart(); initEnergyChart(); initMetricChart();
      run();
    }).catch(function() { run(); });
  } else {
    run();
  }
  if (types.has('data-table-daily')) updateDailyTable().catch(function() {});
  if (types.has('data-table-monthly')) updateMonthlyTable().catch(function() {});
}

async function refreshPreviews() {
  try {
    previewState = await fetchDashboardState();
    applyPreviews();
  } catch (e) {
    // Without data the blocks keep their empty "—" state.
    console.warn('Could not load preview data:', e);
  }
}

/** Re-apply data soon (after a block was added, changed or redrawn). */
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(applyPreviews, 250);
}

// ── Selection and the block toolbar ──────────────────────────────────────

var toolbar = null;

function buildToolbar() {
  toolbar = document.createElement('div');
  toolbar.className = 'blk-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Block actions');
  [
    ['settings', 'settings', 'Edit settings'],
    ['duplicate', 'copy', 'Duplicate'],
    ['visibility', 'eyeOff', 'Hide on dashboard'],
    ['remove', 'trash', 'Remove block']
  ].forEach(function(def) {
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.act = def[0];
    b.className = 'blk-tool' + (def[0] === 'remove' ? ' is-danger' : '');
    b.setAttribute('aria-label', def[2]);
    b.title = def[2];
    b.innerHTML = icon(def[1], 18);
    toolbar.appendChild(b);
  });
  // Keep GridStack from starting a drag when a toolbar button is pressed.
  ['mousedown', 'pointerdown', 'touchstart'].forEach(function(t) {
    toolbar.addEventListener(t, function(e) { e.stopPropagation(); }, { passive: true });
  });
  toolbar.addEventListener('click', function(e) {
    var b = e.target.closest('button');
    if (!b || !selectedBlockId) return;
    e.stopPropagation();
    var id = selectedBlockId;
    if (b.dataset.act === 'settings') openSettings();
    else if (b.dataset.act === 'duplicate') duplicateBlock(id);
    else if (b.dataset.act === 'visibility') toggleBlockHidden(id);
    else if (b.dataset.act === 'remove') removeBlock(id);
  });
}

function updateToolbar() {
  var block = selectedBlockId && findBlock(selectedBlockId);
  if (!toolbar || !block) return;
  var vis = toolbar.querySelector('[data-act="visibility"]');
  var hidden = block.enabled === false;
  var label = hidden ? 'Show on dashboard' : 'Hide on dashboard';
  vis.setAttribute('aria-label', label);
  vis.title = label;
  vis.innerHTML = icon(hidden ? 'eye' : 'eyeOff', 18);
}

var settingsSnapshotTaken = false;

function selectBlock(id, opts) {
  opts = opts || {};
  if (id && !findBlock(id)) id = null;
  var changed = id !== selectedBlockId;
  if (!changed && !opts.force) return;
  selectedBlockId = id;
  settingsSnapshotTaken = false;
  document.querySelectorAll('.grid-stack-item.is-selected').forEach(function(el) {
    el.classList.remove('is-selected');
    var inner = el.querySelector('.grid-stack-item-content');
    var b = findBlock(el.dataset.blockId);
    if (inner && b) inner.setAttribute('aria-label', blockInfo(b.type).name + (b.enabled === false ? ', hidden on dashboard' : ''));
  });
  var el = id ? gridItemEl(id) : null;
  if (el) {
    el.classList.add('is-selected');
    var inner = el.querySelector('.grid-stack-item-content');
    if (!readOnly) inner.appendChild(toolbar);
    var b = findBlock(id);
    inner.setAttribute('aria-label', blockInfo(b.type).name + (b.enabled === false ? ', hidden on dashboard' : '') + ', selected');
    updateToolbar();
  } else if (toolbar) {
    toolbar.remove();
  }
  renderInspector();
  if (!id && document.body.dataset.sheet === 'inspector') closeSheets();
}

function openSettings() {
  if (!selectedBlockId) return;
  if (isNarrow()) { openSheet('inspector'); return; }
  var tab = $('ins-tab-' + inspectorTab);
  if (tab) tab.focus();
}

// ── Block actions ────────────────────────────────────────────────────────

function cellFromPoint(clientX, clientY, w) {
  var rect = $('grid').getBoundingClientRect();
  var colW = rect.width / GRID_COLUMNS;
  var x = Math.floor((clientX - rect.left) / colW);
  var y = Math.floor((clientY - rect.top) / (CELL_HEIGHT * previewScale));
  return { x: Math.max(0, Math.min(GRID_COLUMNS - w, x)), y: Math.max(0, y) };
}

function placeNewItem(block) {
  var item = buildGridItem(block);
  schedulePreview();
  grid.makeWidget(item);  // GridStack v11+ requires makeWidget() for HTMLElements
  syncLayoutFromGrid();
  updateEmptyState();
  selectBlock(block.id, { force: true });
  item.classList.add('is-new');
  setTimeout(function() { item.classList.remove('is-new'); }, 1200);
  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return item;
}

/**
 * Add a block to the active dashboard. With `at` ({x, y}) it goes there;
 * otherwise below the selected block, or at the bottom.
 */
function addBlock(type, at) {
  if (readOnly || !BLOCK_BUILDERS.has(type)) return;
  var tab = currentTab();
  if (!tab) return;
  var info = blockInfo(type);
  pushUndo();
  var w = Math.min(info.w, GRID_COLUMNS);
  var x = 0, y;
  var sel = selectedBlockId && findBlock(selectedBlockId);
  if (at) { x = at.x; y = at.y; }
  else if (sel) { x = Math.min(sel.gridX || 0, GRID_COLUMNS - w); y = (sel.gridY || 0) + (sel.gridH || 1); }
  else { y = grid.getRow(); }
  var block = { id: newBlockId(), type: type, enabled: true, gridX: x, gridY: y, gridW: w, gridH: info.h, config: {} };
  tab.layout.push(block);
  placeNewItem(block);
  closeSheets();
  scheduleSave(0);
  toast(info.name + ' added', { actionLabel: 'Undo', onAction: undo, timeout: 4000 });
}

function duplicateBlock(id) {
  var tab = currentTab();
  var block = findBlock(id);
  if (readOnly || !tab || !block) return;
  pushUndo();
  syncLayoutFromGrid();
  var copy = JSON.parse(JSON.stringify(block));
  copy.id = newBlockId();
  copy.gridY = (block.gridY || 0) + (block.gridH || 1);
  tab.layout.push(copy);
  placeNewItem(copy);
  scheduleSave(0);
  toast(blockInfo(block.type).name + ' duplicated', { actionLabel: 'Undo', onAction: undo, timeout: 4000 });
}

function removeBlock(id) {
  var tab = currentTab();
  var block = findBlock(id);
  if (readOnly || !tab || !block) return;
  pushUndo();
  var name = blockInfo(block.type).name;
  tab.layout = tab.layout.filter(function(b) { return b.id !== id; });
  if (id === selectedBlockId) selectBlock(null);
  var el = gridItemEl(id);
  if (el) grid.removeWidget(el);
  syncLayoutFromGrid();
  updateEmptyState();
  scheduleSave(0);
  toast(name + ' removed', { actionLabel: 'Undo', onAction: undo });
  $('ed-canvas').focus();
}

function toggleBlockHidden(id) {
  var block = findBlock(id);
  if (readOnly || !block) return;
  pushUndo();
  var hide = block.enabled !== false;
  block.enabled = !hide;
  if (block.config) block.config.enabled = !hide;
  refreshGridItem(block);
  updateToolbar();
  if (id === selectedBlockId) renderInspector();
  scheduleSave(0);
  toast(blockInfo(block.type).name + (hide ? ' hidden on the dashboard' : ' shown on the dashboard'), { actionLabel: 'Undo', onAction: undo, timeout: 4000 });
}

/** Move (or with resize: true, resize) the selected block by whole cells. */
function nudgeBlock(id, dx, dy, resize) {
  var el = gridItemEl(id);
  if (readOnly || !el) return;
  var n = el.gridstackNode;
  pushUndo();
  if (resize) grid.update(el, { w: Math.max(1, Math.min(GRID_COLUMNS - n.x, n.w + dx)), h: Math.max(1, n.h + dy) });
  else grid.update(el, { x: Math.max(0, Math.min(GRID_COLUMNS - n.w, n.x + dx)), y: Math.max(0, n.y + dy) });
  syncLayoutFromGrid();
  refreshInspectorLayout();
  scheduleSave();
}

// ── Inspector ────────────────────────────────────────────────────────────

var INSPECTOR_TABS = [['data', 'Data'], ['style', 'Style'], ['layout', 'Layout']];

function sizeText(block) {
  return (block.gridW || 1) + ' columns × ' + (block.gridH || 1) + ' rows';
}

function buildLayoutFields(block) {
  return [
    '<fieldset data-ui="section">',
    '<legend data-ui="legend">Size</legend>',
    '<div data-ui="grid2">',
    '<label data-ui="field">Width (columns)<input type="number" id="ins-w" data-ui="input" min="1" max="' + GRID_COLUMNS + '" step="1" value="' + escHtml(block.gridW || 1) + '"></label>',
    '<label data-ui="field">Height (rows)<input type="number" id="ins-h" data-ui="input" min="1" max="60" step="1" value="' + escHtml(block.gridH || 1) + '"></label>',
    '</div>',
    '<p data-ui="help">The layout is ' + GRID_COLUMNS + ' columns wide and each row is ' + CELL_HEIGHT + ' px tall. With a block selected, arrow keys move it and Shift + arrow keys resize it.</p>',
    '</fieldset>',
    '<fieldset data-ui="section">',
    '<legend data-ui="legend">Visibility</legend>',
    '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="modal-enabled"' + (block.enabled !== false ? ' checked' : '') + '><span class="slider"></span></label><label for="modal-enabled">Show on dashboard</label></span>',
    '<p data-ui="help">Hidden blocks stay here, dimmed, so you can show them again later.</p>',
    '</fieldset>'
  ].join('\n');
}

function renderDashboardSummary(aside) {
  var tab = currentTab();
  var total = tab ? tab.layout.length : 0;
  var hidden = tab ? tab.layout.filter(function(b) { return b.enabled === false; }).length : 0;
  aside.innerHTML =
    '<div class="ins-empty">' +
      '<span class="ins-empty-icon">' + icon('layers', 22) + '</span>' +
      '<h2 class="ed-panel-title">' + escHtml(tab ? tab.name || 'Dashboard' : 'Dashboard') + '</h2>' +
      '<p class="ins-empty-meta">' + total + (total === 1 ? ' block' : ' blocks') + (hidden ? ' · ' + hidden + ' hidden' : '') + '</p>' +
      '<p class="ins-empty-hint">Select a block on the layout to change its data, style and size.</p>' +
      '<ul class="ins-keys">' +
        '<li><span><kbd>Ctrl</kbd> <kbd>Z</kbd></span>Undo</li>' +
        '<li><span><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Z</kbd></span>Redo</li>' +
        '<li><span><kbd>Delete</kbd></span>Remove selected block</li>' +
        '<li><span><kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd></span>Move selected block</li>' +
        '<li><span><kbd>Shift</kbd> + arrows</span>Resize selected block</li>' +
      '</ul>' +
    '</div>';
}

function renderInspector() {
  var aside = $('inspector');
  var block = selectedBlockId && findBlock(selectedBlockId);
  if (!block) { renderDashboardSummary(aside); return; }
  var info = blockInfo(block.type);
  var known = BLOCK_BUILDERS.has(block.type);

  var tabs = INSPECTOR_TABS.map(function(t) {
    var on = t[0] === inspectorTab;
    return '<button type="button" role="tab" class="ins-tab" id="ins-tab-' + t[0] + '" data-tab="' + t[0] + '" aria-controls="ins-panel-' + t[0] + '" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '">' + t[1] + '</button>';
  }).join('');
  var dataPanel = known
    ? buildSettingsForm(block)
    : '<p data-ui="help">This block type isn\'t available in this version of Epilykos, so it has no settings here. You can still move, resize or remove it.</p>';

  aside.innerHTML =
    '<div class="ed-sheet-handle" aria-hidden="true"></div>' +
    '<div class="ins-head">' +
      '<span class="ins-icon">' + icon(info.icon, 20) + '</span>' +
      '<div class="ins-titles"><h2 class="ed-panel-title" id="ins-title">' + escHtml(info.name) + '</h2>' +
      '<p class="ins-sub" id="ins-sub">' + escHtml(sizeText(block)) + '</p></div>' +
      '<button type="button" class="ed-icon-btn" id="ins-close" aria-label="Close settings">' + icon('close', 18) + '</button>' +
    '</div>' +
    '<div class="ins-tabs" role="tablist" aria-labelledby="ins-title">' + tabs + '</div>' +
    '<form class="ins-body" id="ins-body" autocomplete="off" novalidate>' +
      '<fieldset class="ins-fieldset"' + (readOnly ? ' disabled' : '') + '>' +
        '<div role="tabpanel" class="ins-panel" id="ins-panel-data" aria-labelledby="ins-tab-data">' + dataPanel + '</div>' +
        '<div role="tabpanel" class="ins-panel" id="ins-panel-style" aria-labelledby="ins-tab-style">' + buildAppearanceFields(block) + '</div>' +
        '<div role="tabpanel" class="ins-panel" id="ins-panel-layout" aria-labelledby="ins-tab-layout">' + buildLayoutFields(block) + '</div>' +
      '</fieldset>' +
    '</form>' +
    '<div class="ins-foot">' +
      '<p class="ins-msg" id="ins-msg" role="status">' + (readOnly ? 'Read-only' : 'Changes apply as you edit') + '</p>' +
      (readOnly ? '' : '<button type="button" class="ed-btn-text is-danger" id="ins-remove">Remove block</button>') +
    '</div>';

  showInspectorTab(inspectorTab, false);
  wireInspector(aside, block);
}

function showInspectorTab(name, focus) {
  inspectorTab = name;
  INSPECTOR_TABS.forEach(function(t) {
    var tab = $('ins-tab-' + t[0]);
    var panel = $('ins-panel-' + t[0]);
    if (!tab || !panel) return;
    var on = t[0] === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  });
  if (focus) $('ins-tab-' + name).focus();
}

function refreshInspectorLayout() {
  var block = selectedBlockId && findBlock(selectedBlockId);
  if (!block) return;
  var sub = $('ins-sub');
  if (sub) sub.textContent = sizeText(block);
  var w = $('ins-w'), h = $('ins-h');
  if (w && document.activeElement !== w) w.value = block.gridW || 1;
  if (h && document.activeElement !== h) h.value = block.gridH || 1;
}

var applyTimer = null;

function applySettings() {
  clearTimeout(applyTimer);
  var block = selectedBlockId && findBlock(selectedBlockId);
  if (!block || readOnly) return;
  var msg = $('ins-msg');
  if (BLOCK_BUILDERS.has(block.type)) {
    var err = readSettingsForm(block);
    if (err) {
      if (msg) { msg.textContent = err; msg.classList.add('is-error'); }
      return;  // keep the last valid settings; nothing is saved
    }
  } else {
    var en = $('modal-enabled');
    if (en) block.enabled = en.checked;
  }
  if (msg) { msg.textContent = 'Changes apply as you edit'; msg.classList.remove('is-error'); }
  refreshGridItem(block);
  updateToolbar();
  scheduleSave();
}

function scheduleApply(delay) {
  if (!settingsSnapshotTaken) { pushUndo(); settingsSnapshotTaken = true; }
  clearTimeout(applyTimer);
  applyTimer = setTimeout(applySettings, delay);
}

/** Values of every control in each row of a row list, by row index. */
function captureRows(rowsEl) {
  return Array.from(rowsEl.children).map(function(row) {
    return Array.from(row.querySelectorAll('input, select, textarea')).map(function(c) {
      return { value: c.value, checked: c.checked, dirty: c.dataset.dirty };
    });
  });
}
function restoreRows(rowsEl, saved, removedIdx) {
  Array.from(rowsEl.children).forEach(function(row, i) {
    var src = removedIdx == null ? saved[i] : saved[i < removedIdx ? i : i + 1];
    if (!src) return;
    Array.from(row.querySelectorAll('input, select, textarea')).forEach(function(c, j) {
      var v = src[j];
      if (!v) return;
      if (c.type === 'checkbox' || c.type === 'radio') c.checked = v.checked;
      else c.value = v.value;
      if (v.dirty) c.dataset.dirty = v.dirty;
    });
  });
}

function wireInspector(aside, block) {
  $('ins-close').addEventListener('click', function() {
    if (isNarrow()) { closeSheets(); return; }
    var el = gridItemEl(block.id);
    selectBlock(null);
    if (el) el.querySelector('.grid-stack-item-content').focus();
  });
  var remove = $('ins-remove');
  if (remove) remove.addEventListener('click', function() { removeBlock(block.id); });

  var tablist = aside.querySelector('.ins-tabs');
  tablist.addEventListener('click', function(e) {
    var t = e.target.closest('[role="tab"]');
    if (t) showInspectorTab(t.dataset.tab, false);
  });
  tablist.addEventListener('keydown', function(e) {
    var i = INSPECTOR_TABS.findIndex(function(t) { return t[0] === inspectorTab; });
    var next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % INSPECTOR_TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = INSPECTOR_TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    showInspectorTab(INSPECTOR_TABS[next][0], true);
  });

  var body = $('ins-body');
  body.addEventListener('submit', function(e) { e.preventDefault(); });
  wireSettingsForm(body, block);
  var cgAddThreshold = body.querySelector('#cg-threshold-add');
  if (cgAddThreshold) cgAddThreshold.addEventListener('click', function() {
    var rows = body.querySelector('#cg-threshold-rows');
    var row = document.createElement('div'); row.setAttribute('data-ui', 'row');
    row.innerHTML = '<label>Threshold <input class="cg-threshold-value" type="number" step="any" value=""></label><label>Color <input class="cg-threshold-color" type="text" placeholder="Use theme default" value=""></label><button type="button" aria-label="Remove threshold">Remove</button>';
    row.querySelector('button').addEventListener('click', function() { row.remove(); scheduleApply(0); });
    rows.appendChild(row); scheduleApply(0);
  });
  body.querySelectorAll('#cg-threshold-rows [data-ui="row"]').forEach(function(row) {
    var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove threshold');
    remove.addEventListener('click', function() { row.remove(); scheduleApply(0); }); row.appendChild(remove);
  });
  if (readOnly) return;

  body.addEventListener('input', function(e) {
    if (e.target.id === 'ins-w' || e.target.id === 'ins-h') return;
    scheduleApply(350);
  });
  body.addEventListener('change', function(e) {
    if (e.target.id === 'ins-w' || e.target.id === 'ins-h') { resizeFromInspector(block); return; }
    scheduleApply(0);
  });

  // Row lists (series, bands, states...) re-render themselves from a JSON
  // snapshot when a row is added or removed, which used to throw away what
  // had been typed. Keep the typed values across that re-render.
  var pending = null;
  body.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var isAdd = /-add(-row)?$/.test(btn.id);
    var isRemove = btn.classList.contains('row-remove-btn');
    if (!isAdd && !isRemove) return;
    var rowsEl = isRemove ? btn.closest('[id$="-rows"]') : (btn.closest('fieldset') || body).querySelector('[id$="-rows"]');
    if (!rowsEl) return;
    pending = { rowsEl: rowsEl, id: rowsEl.id, saved: captureRows(rowsEl), removedIdx: isRemove ? parseInt(btn.dataset.idx, 10) : null };
  }, true);
  body.addEventListener('click', function() {
    if (!pending) return;
    var p = pending;
    pending = null;
    var rowsEl = document.getElementById(p.id);
    if (rowsEl) restoreRows(rowsEl, p.saved, p.removedIdx);
    scheduleApply(0);
  });
}

function resizeFromInspector(block) {
  var el = gridItemEl(block.id);
  if (!el) return;
  var w = Math.max(1, Math.min(GRID_COLUMNS, parseInt($('ins-w').value, 10) || 1));
  var h = Math.max(1, Math.min(60, parseInt($('ins-h').value, 10) || 1));
  pushUndo();
  grid.update(el, { w: w, h: h });
  syncLayoutFromGrid();
  refreshInspectorLayout();
  scheduleSave();
}

/** Hook up the dynamic parts of a block's settings form. */
function wireSettingsForm(body, block) {
  // Color inputs are only saved once the person has actually picked a color.
  ['modal-bgcolor', 'modal-fontcolor', 'modal-switch-oncolor', 'modal-switch-offcolor'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', function() { this.dataset.dirty = 'true'; }, { once: true });
  });

  // S5-editor: toggle rest_map textarea with source pick (rest: -> show, else hide + clear error)
  var srcSel = document.getElementById('modal-simple-source');
  var rmWrap = document.getElementById('modal-restmap-wrap');
  if (srcSel && rmWrap) srcSel.addEventListener('change', function() {
    var show = (srcSel.value || '').indexOf('rest:') === 0;
    rmWrap.style.display = show ? '' : 'none';
    if (!show) { var rmErr = document.getElementById('modal-restmap-error'); if (rmErr) { rmErr.textContent = ''; rmErr.style.display = 'none'; } }
  });

  // Initialize dynamic row renderers after DOM is populated
  switch (block.type) {
    case 'multi-value':
      renderMultiValueRows(body);
      break;
    case 'bar-gauge':
      renderBarGaugeRows(body);
      break;
    case 'bar-gauge-retro':
      renderBarGaugeRetroRows(body);
      break;
    case 'bar-single':
      renderBarSingleRows(body);
      break;
    case 'bar-stacked':
      renderBarStackedRows(body);
      break;
    case 'bar-threshold':
      renderBarThresholdRows(body);
      break;
    case 'metric-cards':
      renderMetricCardsRows(body);
      break;
    case 'chart-power':
      renderChartRows(body, false, [{ value: 'battery_power', label: 'Battery Power (net)' }]);
      break;
    case 'chart-energy':
      renderChartRows(body);
      break;
    case 'chart-metric':
      renderChartRows(body, true);
      break;
    case 'state-select':
      renderStateSelectRows(body);
      break;
    case 'weather-block':
      renderWeatherAlertRows(body);
      break;
  }
}

// ── Block library ────────────────────────────────────────────────────────

var COLLAPSED_KEY = 'epilykos.editor.collapsedGroups';
var collapsedGroups = new Set();
var draggingType = null;

function loadCollapsed() {
  try { collapsedGroups = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch (e) { collapsedGroups = new Set(); }
}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(collapsedGroups))); } catch (e) {}
}

function libraryGroups() {
  var groups = GROUPS.map(function(g) { return { id: g.id, label: g.label, types: [] }; });
  var other = { id: 'other', label: 'Other', types: [] };
  BLOCK_BUILDERS.forEach(function(_b, type) {
    var info = blockInfo(type);
    var g = groups.find(function(x) { return x.id === info.group; });
    (g || other).types.push(type);
  });
  // Keep the catalog's order inside each group.
  var order = Object.keys(BLOCKS);
  groups.forEach(function(g) { g.types.sort(function(a, b) { return order.indexOf(a) - order.indexOf(b); }); });
  if (other.types.length) groups.push(other);
  return groups.filter(function(g) { return g.types.length; });
}

function renderLibrary(query) {
  var list = $('library-list');
  var q = (query || '').trim().toLowerCase();
  var html = '';
  var shown = 0;
  libraryGroups().forEach(function(g) {
    var types = g.types.filter(function(type) {
      if (!q) return true;
      var info = blockInfo(type);
      return (info.name + ' ' + info.desc + ' ' + type + ' ' + g.label).toLowerCase().indexOf(q) !== -1;
    });
    if (!types.length) return;
    shown += types.length;
    var collapsed = !q && collapsedGroups.has(g.id);
    var listId = 'lib-group-' + g.id;
    html += '<section class="lib-group">' +
      '<h3 class="lib-group-head"><button type="button" class="lib-group-btn" data-group="' + g.id + '" aria-expanded="' + !collapsed + '" aria-controls="' + listId + '">' +
        '<span>' + escHtml(g.label) + '</span><span class="lib-count">' + types.length + '</span>' + icon(collapsed ? 'chevronDown' : 'chevronUp', 14) +
      '</button></h3>' +
      '<ul class="lib-items" id="' + listId + '"' + (collapsed ? ' hidden' : '') + '>';
    types.forEach(function(type) {
      var info = blockInfo(type);
      html += '<li><button type="button" class="lib-item" draggable="true" data-type="' + escHtml(type) + '">' +
        '<span class="lib-icon">' + icon(info.icon, 20) + '</span>' +
        '<span class="lib-text"><span class="lib-name">' + escHtml(info.name) + '</span>' +
        (info.desc ? '<span class="lib-desc">' + escHtml(info.desc) + '</span>' : '') + '</span>' +
      '</button></li>';
    });
    html += '</ul></section>';
  });
  if (!shown) html = '<p class="lib-empty">No blocks match “' + escHtml(query.trim()) + '”.</p>';
  list.innerHTML = html;
}

function wireLibrary() {
  loadCollapsed();
  renderLibrary('');
  var search = $('library-search');
  search.addEventListener('input', function() { renderLibrary(search.value); });
  search.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowDown') { var first = $('library-list').querySelector('.lib-item'); if (first) { e.preventDefault(); first.focus(); } }
    if (e.key === 'Enter') { var only = $('library-list').querySelectorAll('.lib-item'); if (only.length) { e.preventDefault(); addBlock(only[0].dataset.type); } }
  });

  var list = $('library-list');
  list.addEventListener('click', function(e) {
    var gb = e.target.closest('.lib-group-btn');
    if (gb) {
      var id = gb.dataset.group;
      if (collapsedGroups.has(id)) collapsedGroups.delete(id); else collapsedGroups.add(id);
      saveCollapsed();
      renderLibrary(search.value);
      var again = list.querySelector('.lib-group-btn[data-group="' + id + '"]');
      if (again) again.focus();
      return;
    }
    var item = e.target.closest('.lib-item');
    if (item) addBlock(item.dataset.type);
  });
  list.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var focusables = Array.from(list.querySelectorAll('.lib-group-btn, .lib-items:not([hidden]) .lib-item'));
    var i = focusables.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    var next = focusables[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus(); else if (e.key === 'ArrowUp') search.focus();
  });
  list.addEventListener('dragstart', function(e) {
    var item = e.target.closest('.lib-item');
    if (!item || readOnly) { e.preventDefault(); return; }
    draggingType = item.dataset.type;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('blockType', draggingType);
    e.dataTransfer.setData('text/plain', blockInfo(draggingType).name);
  });
  list.addEventListener('dragend', function() {
    draggingType = null;
    $('ed-canvas').classList.remove('is-drop-target');
  });
}

// ── Canvas ───────────────────────────────────────────────────────────────

function wireCanvas() {
  var canvas = $('ed-canvas');
  // Palette drop target — bound once (loadTab runs on every dashboard switch).
  canvas.addEventListener('dragover', function(e) {
    if (readOnly || !draggingType) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    canvas.classList.add('is-drop-target');
  });
  canvas.addEventListener('dragleave', function(e) {
    if (!canvas.contains(e.relatedTarget)) canvas.classList.remove('is-drop-target');
  });
  canvas.addEventListener('drop', function(e) {
    canvas.classList.remove('is-drop-target');
    var type = e.dataTransfer.getData('blockType') || draggingType;
    draggingType = null;
    if (!type || readOnly) return;
    e.preventDefault();
    addBlock(type, cellFromPoint(e.clientX, e.clientY, Math.min(blockInfo(type).w, GRID_COLUMNS)));
  });

  // Selecting blocks: click or Enter / Space; click on empty space clears it.
  canvas.addEventListener('click', function(e) {
    if (e.target.closest('.blk-toolbar')) return;
    var inner = e.target.closest('.grid-stack-item-content');
    if (inner) selectBlock(inner.parentElement.dataset.blockId);
    else if (!e.target.closest('.grid-stack-item')) selectBlock(null);
  });
  canvas.addEventListener('keydown', function(e) {
    var inner = e.target.classList && e.target.classList.contains('grid-stack-item-content') ? e.target : null;
    if (!inner) return;
    var id = inner.parentElement.dataset.blockId;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (selectedBlockId === id) openSettings(); else selectBlock(id);
      return;
    }
    if (id !== selectedBlockId) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeBlock(id); return; }
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      nudgeBlock(id, arrows[e.key][0], arrows[e.key][1], e.shiftKey);
      inner.focus();
    }
  });
}

// ── Dashboards ───────────────────────────────────────────────────────────

function updateHeader() {
  var tab = currentTab();
  var idx = dashboardConfig.dashboards.indexOf(tab);
  $('dash-name').textContent = (tab && tab.name) || 'Dashboard';
  $('dash-count').textContent = dashboardConfig.dashboards.length > 1 ? (idx + 1) + ' of ' + dashboardConfig.dashboards.length : '';
  $('dash-menu-btn').setAttribute('aria-label', 'Dashboard: ' + ((tab && tab.name) || 'Dashboard') + '. Switch, rename or manage dashboards');
  document.title = 'Edit ' + ((tab && tab.name) || 'layout') + ' · Epilykos';
  try {
    var url = new URL(window.location.href);
    url.searchParams.set('tab', currentTabId);
    history.replaceState(null, '', url.pathname + url.search);
  } catch (e) {}
}

function loadTab(tabId, opts) {
  opts = opts || {};
  var tab = dashboardConfig.dashboards.find(function(db) { return db.id === tabId; });
  if (!tab) return;
  if (!opts.skipSync) syncLayoutFromGrid();
  currentTabId = tabId;
  if (toolbar) toolbar.remove();
  selectedBlockId = null;

  var container = $('grid');
  if (grid) { grid.destroy(false); grid = null; }
  container.innerHTML = '';
  tab.layout.forEach(function(block) {
    // Hidden blocks are drawn too (dimmed) so they can be shown again.
    container.appendChild(buildGridItem(block));
  });

  applyPreviewScale();
  grid = GridStack.init({
    column: GRID_COLUMNS, cellHeight: CELL_HEIGHT * previewScale, margin: GRID_MARGIN * previewScale,
    float: false, animate: true, minRow: 4,
    staticGrid: readOnly,
    resizable: { handles: 'e, se, s, sw, w' },
    draggable: { cancel: 'input,textarea,button,select,option,.blk-toolbar' }
  }, container);
  grid.on('dragstart resizestart', function() { pushUndo(); });
  grid.on('dragstop resizestop', function() { syncLayoutFromGrid(); refreshInspectorLayout(); scheduleSave(); });

  updateHeader();
  updateEmptyState();
  selectBlock(opts.keepSelection || null, { force: true });
  schedulePreview();
}

function renameDashboard(title) {
  var tab = currentTab();
  if (!tab || readOnly) return Promise.resolve();
  var wrap = document.createElement('div');
  wrap.className = 'ed-field';
  var label = document.createElement('label');
  label.htmlFor = 'rename-input';
  label.textContent = 'Name';
  var input = document.createElement('input');
  input.id = 'rename-input';
  input.name = 'name';
  input.type = 'text';
  input.required = true;
  input.maxLength = 60;
  input.value = tab.name || '';
  wrap.appendChild(label);
  wrap.appendChild(input);
  return openDialog({ title: title || 'Rename dashboard', body: wrap, confirmLabel: 'Save name' }).then(function(form) {
    if (!form) return;
    var name = form.elements.name.value.trim();
    if (!name || name === tab.name) return;
    pushUndo();
    tab.name = name;
    updateHeader();
    if (!selectedBlockId) renderInspector();
    scheduleSave(0);
  });
}

function newDashboard() {
  if (readOnly) return;
  pushUndo();
  var used = new Set(dashboardConfig.dashboards.map(function(db) { return db.id; }));
  var id = uniqueDashboardId('db_' + Date.now(), used);
  dashboardConfig.dashboards.push({ id: id, name: 'New dashboard', layout: [] });
  loadTab(id);
  scheduleSave(0);
  renameDashboard('Name your new dashboard');
}

function duplicateDashboard() {
  var tab = currentTab();
  if (readOnly || !tab) return;
  pushUndo();
  var used = new Set(dashboardConfig.dashboards.map(function(db) { return db.id; }));
  var copy = JSON.parse(JSON.stringify(tab));
  copy.id = uniqueDashboardId(tab.id + '_copy', used);
  copy.name = (tab.name || 'Dashboard') + ' copy';
  copy.layout.forEach(function(b) { b.id = newBlockId(); });
  dashboardConfig.dashboards.splice(dashboardConfig.dashboards.indexOf(tab) + 1, 0, copy);
  loadTab(copy.id);
  scheduleSave(0);
  toast('Created "' + copy.name + '"', { actionLabel: 'Undo', onAction: undo });
}

function deleteDashboard() {
  var tab = currentTab();
  if (readOnly || !tab || dashboardConfig.dashboards.length <= 1) return;
  var n = tab.layout.length;
  var p = document.createElement('p');
  p.textContent = 'This removes the dashboard and its ' + n + (n === 1 ? ' block' : ' blocks') + '. You can undo this right after.';
  openDialog({ title: 'Delete "' + (tab.name || 'Dashboard') + '"?', body: p, confirmLabel: 'Delete dashboard', danger: true, alert: true }).then(function(form) {
    if (!form) return;
    pushUndo();
    dashboardConfig.dashboards = dashboardConfig.dashboards.filter(function(db) { return db.id !== tab.id; });
    if (dashboardConfig.activeDashboard === tab.id) dashboardConfig.activeDashboard = dashboardConfig.dashboards[0].id;
    loadTab(dashboardConfig.dashboards[0].id, { skipSync: true });
    scheduleSave(0);
    toast('Deleted "' + (tab.name || 'Dashboard') + '"', { actionLabel: 'Undo', onAction: undo, timeout: 10000 });
  });
}

function exportLayout() {
  syncLayoutFromGrid();
  var json = JSON.stringify(dashboardConfig, null, 2);
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = 'dashboard-config.json';
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
  toast('Exported ' + dashboardConfig.dashboards.length + (dashboardConfig.dashboards.length === 1 ? ' dashboard' : ' dashboards'));
}

function importOptionsBody(fileName, importedCount, existingCount) {
  var wrap = document.createElement('div');
  wrap.className = 'ed-import';
  var file = document.createElement('div');
  file.className = 'ed-import-file';
  file.innerHTML = icon('file', 18);
  var fname = document.createElement('span');
  fname.className = 'ed-import-name';
  fname.textContent = fileName;
  var fcount = document.createElement('span');
  fcount.className = 'ed-import-count';
  fcount.textContent = importedCount + (importedCount === 1 ? ' dashboard' : ' dashboards');
  file.appendChild(fname);
  file.appendChild(fcount);
  wrap.appendChild(file);

  var fs = document.createElement('fieldset');
  fs.className = 'ed-choice-group';
  var legend = document.createElement('legend');
  legend.textContent = 'How should it be added?';
  fs.appendChild(legend);
  [
    ['Append', 'Add alongside your dashboards', 'You\'ll have ' + (existingCount + importedCount) + ' dashboards. Duplicate IDs get a suffix.'],
    ['Replace', 'Replace all dashboards', 'Your ' + existingCount + ' current ' + (existingCount === 1 ? 'dashboard' : 'dashboards') + ' will be removed. You can undo this right after.']
  ].forEach(function(opt, i) {
    var label = document.createElement('label');
    label.className = 'ed-choice';
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'importMode';
    input.value = opt[0];
    input.checked = i === 0;
    var text = document.createElement('span');
    var title = document.createElement('span');
    title.className = 'ed-choice-title';
    title.textContent = opt[1];
    var desc = document.createElement('span');
    desc.className = 'ed-choice-desc';
    desc.textContent = opt[2];
    text.appendChild(title);
    text.appendChild(desc);
    label.appendChild(input);
    label.appendChild(text);
    fs.appendChild(label);
  });
  wrap.appendChild(fs);
  return wrap;
}

function importLayout() {
  if (readOnly) return;
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var imported;
    try {
      imported = JSON.parse(await file.text());
      if (!imported || !Array.isArray(imported.dashboards)) throw new Error('Invalid format: dashboards must be an array');
    } catch (err) {
      toast('Import failed: ' + err.message, { tone: 'error', timeout: 8000 });
      return;
    }
    var importedCount = imported.dashboards.length;
    var existingCount = dashboardConfig.dashboards.length;
    var form = await openDialog({
      title: 'Import layout',
      body: importOptionsBody(file.name, importedCount, existingCount),
      confirmLabel: 'Import ' + importedCount + (importedCount === 1 ? ' dashboard' : ' dashboards')
    });
    if (!form) return;
    var choice = form.elements.importMode.value;
    if (choice !== 'Append' && choice !== 'Replace') return;
    var next;
    try {
      next = applyDashboardImport(dashboardConfig, imported, choice);
      if (!next.dashboards.length) throw new Error('The file has no dashboards');
    } catch (err) {
      toast('Import failed: ' + err.message, { tone: 'error', timeout: 8000 });
      return;
    }
    pushUndo();
    dashboardConfig = next;
    dashboardConfig.dashboards.forEach(function(db) { if (!Array.isArray(db.layout)) db.layout = []; });
    var tabId = choice === 'Replace' || !dashboardConfig.dashboards.some(function(db) { return db.id === currentTabId; })
      ? dashboardConfig.dashboards[0].id
      : currentTabId;
    if (choice === 'Replace' && !dashboardConfig.dashboards.some(function(db) { return db.id === dashboardConfig.activeDashboard; })) {
      dashboardConfig.activeDashboard = tabId;
    }
    loadTab(tabId, { skipSync: true });
    scheduleSave(0);
    toast('Imported ' + importedCount + (importedCount === 1 ? ' dashboard' : ' dashboards'), { actionLabel: 'Undo', onAction: undo, timeout: 10000 });
  });
  input.click();
}

function openDashboardMenu() {
  var only = dashboardConfig.dashboards.length <= 1;
  var items = dashboardConfig.dashboards.map(function(db) {
    return { label: db.name || db.id, checked: db.id === currentTabId, onSelect: function() { if (db.id !== currentTabId) loadTab(db.id); } };
  });
  items.push({ separator: true });
  items.push({ label: 'Rename…', icon: 'text', disabled: readOnly, onSelect: function() { renameDashboard(); } });
  items.push({ label: 'Duplicate', icon: 'copy', disabled: readOnly, onSelect: duplicateDashboard });
  items.push({ label: 'New dashboard', icon: 'plus', disabled: readOnly, onSelect: newDashboard });
  if (isNarrow()) {
    items.push({ separator: true });
    items.push({ label: 'Export all dashboards', icon: 'file', onSelect: exportLayout });
    items.push({ label: 'Import from file…', icon: 'file', disabled: readOnly, onSelect: importLayout });
  }
  items.push({ separator: true });
  items.push({ label: 'Delete dashboard…', icon: 'trash', danger: true, disabled: readOnly || only, hint: only ? 'Only one left' : '', onSelect: deleteDashboard });
  openMenu($('dash-menu-btn'), items, { label: 'Dashboards' });
}

function openIoMenu() {
  openMenu($('io-btn'), [
    { label: 'Export all dashboards', icon: 'file', onSelect: exportLayout },
    { label: 'Import from file…', icon: 'file', disabled: readOnly, onSelect: importLayout }
  ], { label: 'Import or export' });
}

// ── Leaving the editor ───────────────────────────────────────────────────

var leaving = false;

function isSettled() { return !saveTimer && !saving && saveState === 'saved'; }

async function leaveTo(url, opts) {
  opts = opts || {};
  var ok = readOnly || isSettled() || await flushSave();
  if (!ok) {
    if (opts.allowDiscard) {
      var form = await openDialog({
        title: 'Leave without saving?',
        body: "<p>Your latest changes couldn't be saved. If you leave now, they'll be lost.</p>",
        confirmLabel: 'Leave anyway', cancelLabel: 'Stay', danger: true, alert: true
      });
      if (!form) return;
    } else {
      toast("Your changes aren't saved yet. Use Retry at the top, then try again.", { tone: 'error', timeout: 8000 });
      return;
    }
  }
  leaving = true;
  window.location.href = url;
}

// ── Sheets (narrow screens) ──────────────────────────────────────────────

function openSheet(name) {
  if (!isNarrow()) return;
  document.body.dataset.sheet = name;
  $('sheet-scrim').hidden = false;
  $('library-btn').setAttribute('aria-expanded', String(name === 'library'));
  var sheet = $(name);
  var focusTarget = name === 'library' ? $('library-search') : sheet.querySelector('[role="tab"][aria-selected="true"]');
  if (focusTarget) setTimeout(function() { focusTarget.focus(); }, 50);
}

function closeSheets() {
  var was = document.body.dataset.sheet;
  if (!was) return;
  delete document.body.dataset.sheet;
  $('sheet-scrim').hidden = true;
  $('library-btn').setAttribute('aria-expanded', 'false');
  if (was === 'library') $('library-btn').focus();
}

// ── Setup ────────────────────────────────────────────────────────────────

function hydrateIcons(root) {
  root.querySelectorAll('[data-icon]').forEach(function(el) {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, parseInt(el.dataset.size, 10) || 20));
    el.removeAttribute('data-icon');
  });
}

function enterReadOnly() {
  readOnly = true;
  document.body.classList.add('is-readonly');
  $('readonly-banner').hidden = false;
  $('library').setAttribute('inert', '');
  $('library-btn').disabled = true;
  setSaveStatus('readonly');
  updateUndoButtons();
}

function wireTopbar() {
  $('dash-menu-btn').addEventListener('click', openDashboardMenu);
  $('io-btn').addEventListener('click', openIoMenu);
  $('undo-btn').addEventListener('click', undo);
  $('redo-btn').addEventListener('click', redo);
  $('done-btn').addEventListener('click', function() {
    leaveTo('/?tab=' + encodeURIComponent(currentTabId));
  });
  $('back-link').addEventListener('click', function(e) {
    e.preventDefault();
    leaveTo('/?tab=' + encodeURIComponent(currentTabId), { allowDiscard: true });
  });
  $('library-btn').addEventListener('click', function() {
    if (document.body.dataset.sheet === 'library') closeSheets(); else openSheet('library');
  });
  $('sheet-scrim').addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close-sheet]').forEach(function(b) { b.addEventListener('click', closeSheets); });
  window.matchMedia('(max-width: 900px)').addEventListener('change', closeSheets);

  window.addEventListener('beforeunload', function(e) {
    if (leaving || readOnly || isSettled()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', function(e) {
    if (document.querySelector('dialog[open]')) return;
    var t = e.target;
    var typing = t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');
    var mod = e.ctrlKey || e.metaKey;
    var key = (e.key || '').toLowerCase();
    if (mod && !typing && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && !typing && key === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') {
      if (isMenuOpen()) { closeMenu(true); return; }
      if (document.body.dataset.sheet) { closeSheets(); return; }
      if (selectedBlockId && !typing) {
        var el = gridItemEl(selectedBlockId);
        selectBlock(null);
        if (el) el.querySelector('.grid-stack-item-content').focus();
      }
    }
  });
}

async function initEditor() {
  initTheme();
  hydrateIcons(document);
  showLoading('Loading editor…');
  try {
    fetch('/api/settings').then(function(r) { return r.json(); }).then(function(s) {
      try {
        var ext = JSON.parse(s.external_sources || '[]');
        availableRestSources = ext.map(function(x) { return x.name; }).filter(Boolean);
      } catch (e) { availableRestSources = []; }
    }).catch(function() { availableRestSources = []; });
    // Metrics for the settings dropdowns: fetched once, not on every open.
    metricsPromise = fetchDashboardState().then(function(state) {
      availableMetrics = state.metrics ? Object.keys(state.metrics).sort() : [];
    }).catch(function(e) {
      console.warn('Could not fetch metrics for settings dropdowns:', e);
      availableMetrics = [];
    });
    var authPromise = fetch('/api/auth/status').then(function(r) { return r.json(); }).catch(function() { return { authenticated: true }; });

    dashboardConfig = await fetchDashboardConfig();
    if (!dashboardConfig || typeof dashboardConfig !== 'object') dashboardConfig = {};
    if (!Array.isArray(dashboardConfig.dashboards) || !dashboardConfig.dashboards.length) {
      dashboardConfig.dashboards = [{ id: 'main', name: 'Main', layout: [] }];
      dashboardConfig.activeDashboard = 'main';
    }
    dashboardConfig.dashboards.forEach(function(db) { if (!Array.isArray(db.layout)) db.layout = []; });
    var requestedTab = new URLSearchParams(window.location.search).get('tab');
    currentTabId = dashboardConfig.dashboards.some(function(db) { return db.id === requestedTab; })
      ? requestedTab
      : (dashboardConfig.dashboards.some(function(db) { return db.id === dashboardConfig.activeDashboard; })
        ? dashboardConfig.activeDashboard
        : dashboardConfig.dashboards[0].id);

    var auth = await authPromise;
    if (auth && auth.authenticated === false) enterReadOnly();
    await metricsPromise;

    buildToolbar();
    wireLibrary();
    wireCanvas();
    wireTopbar();
    wireKeyboard();
    loadTab(currentTabId, { skipSync: true });
    refreshPreviews();
    if (window.ResizeObserver) new ResizeObserver(function() { applyPreviewScale(); }).observe($('grid'));
    window.addEventListener('resize', applyPreviewScale);
    setInterval(function() { if (!document.hidden) refreshPreviews(); }, 30000);
    setSaveStatus(readOnly ? 'readonly' : 'saved');
    updateUndoButtons();
    hideLoading();
  } catch (e) {
    console.error('Editor failed to load:', e);
    hideLoading();
    var empty = $('empty-state');
    empty.hidden = false;
    empty.innerHTML = '<h2>The editor couldn\'t load</h2><p></p><button type="button" class="ed-btn ed-btn-primary">Try again</button>';
    empty.querySelector('p').textContent = e.message || String(e);
    empty.querySelector('button').addEventListener('click', function() { window.location.reload(); });
  }
}

initEditor();
