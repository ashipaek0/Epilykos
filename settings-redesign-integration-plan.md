# Epilykos Settings Redesign — Integration Plan

## Overview: v2 Mockup → Real Code Mapping

The v2 mockup (`ui-settings-redesign-v2.html`) is a standalone HTML file with embedded CSS and JS. The production settings page consists of:
- `public/settings.html` — 1054 lines, HTML structure with `<style>` import from `style.css`, inline JS (~250 lines), and loads `settings.js`
- `public/settings.js` — 3404 lines, all device builders, form handling, load/save
- `public/style.css` — 1461 lines, shared design tokens + `stg-*` classes used across the app

The integration is a **partial rewrite** of `settings.html` (HTML structure + CSS classes + inline JS) and a **targeted refactor** of `settings.js` (remove dashboard editor, update DOM references). `style.css` needs a small token extension.

---

## 1. Section Mapping Table

| Old Section ID (`stg-section-*`) | New Section ID (`section-*`) | Notes |
|---|---|---|
| `stg-section-data-sources` | `section-data-sources` | Rename prefix. Sub-tab IDs `subtab-ha` etc. stay identical. |
| `stg-section-metrics` | `section-metrics` | Rename prefix. |
| `stg-section-solar` | `section-solar` | Rename prefix. |
| `stg-section-dashboard` | `section-dashboard` | **Major change**: remove `active-dashboard-editor` inline block editor. |
| `stg-section-savings` | `section-savings` | Rename prefix. |
| `stg-section-backup` | `section-backup` | Rename prefix. |
| `stg-section-branding` | `section-branding` | Rename prefix. Previously unconditional section; now grouped under "Dashboard & Display". |
| `stg-section-network` | `section-network` | Rename prefix. |
| `stg-section-help` | `section-help` | Rename prefix. Accordion structure unchanged but CSS classes updated. |

**Key: All section IDs drop the `stg-` prefix, matching v2 mockup's `section-*` convention.**

---

## 2. DOM ID Inventory — Complete `settings.js` Reference

### 2.1 Top-level (must survive — referenced at module scope)

| ID | Usage in settings.js | Action |
|---|---|---|
| `settings-form` | `document.getElementById('settings-form')` — form submit listener | **RENAME** to keep identical ID |
| `save-status` | Status display after save | **PRESERVE** |
| `backup-status` | Backup/restore status | **PRESERVE** |

### 2.2 Device container IDs (must survive exactly)

These are the IDs that `collectDeviceArray()` and all build/reindex functions depend on:

| ID | Builder Function | Reindex Function | Action |
|---|---|---|---|
| `ha-devices-container` | `buildHaDeviceList` | `reindexHa` | **PRESERVE** |
| `mqtt-devices-container` | `buildMqttDeviceList` | `reindexMqtt` | **PRESERVE** |
| `modbus-devices-container` | `buildModbusDeviceList` | `reindexModbus` | **PRESERVE** |
| `rs232-devices-container` | `buildRs232DeviceList` | `reindexRs232` | **PRESERVE** |
| `external-sources-container` | `buildExternalSourceList` | `reindexExternal` | **PRESERVE** |
| `bms-devices-container` | `buildBmsDeviceList` | `reindexBms` | **PRESERVE** |
| `bms-banks-container` | `buildBmsBankList` | `reindexBmsBanks` | **PRESERVE** |
| `dongle-devices-container` | `buildDongleDeviceList` | `reindexDongle` | **PRESERVE** |

### 2.3 "Add" button IDs (must survive exactly)

| ID | Referenced in settings.js line | Action |
|---|---|---|
| `add-ha-device` | L362 | **PRESERVE** |
| `add-mqtt-device` | L629 | **PRESERVE** |
| `add-modbus-device` | L781 | **PRESERVE** |
| `add-rs232-device` | L1172 | **PRESERVE** |
| `add-external-source` | L1309 | **PRESERVE** |
| `add-bms-device` | L1586 | **PRESERVE** |
| `add-bms-bank` | L1844 | **PRESERVE** |
| `add-dongle-device` | L2009 | **PRESERVE** |

### 2.4 PVOutput field IDs (must survive exactly)

| ID | Usage | Action |
|---|---|---|
| `pvoutput-enabled` | Checkbox read/write | **PRESERVE** |
| `pvoutput-api-key` | Input read/write | **PRESERVE** |
| `pvoutput-system-id` | Input read/write | **PRESERVE** |
| `pvoutput-timezone` | Input read/write | **PRESERVE** |
| `pvoutput-interval` | Select read/write | **PRESERVE** |
| `pvoutput-system-size` | Input read/write | **PRESERVE** |
| `pvoutput-webhook-url` | Input read/write | **PRESERVE** |
| `pvoutput-test-btn` | Button click | **PRESERVE** |
| `pvoutput-test-status` | Status display | **PRESERVE** |
| `pvoutput-metrics-container` | Container for metric mapping dropdowns | **PRESERVE** |
| `pvoutput-queue-status` | Queue display | **PRESERVE** |
| `pvoutput-backfill-btn` | Button click | **PRESERVE** |
| `pvoutput-view-queue-btn` | Button click | **PRESERVE** |

### 2.5 Dashboard section IDs

| ID | Usage | Action |
|---|---|---|
| `dashboards-list` | Dashboard name list rendered by `buildDashboardEditor` | **PRESERVE** |
| `active-dashboard-editor` | Inline block editor rendered by `renderDashboardBlockEditor` | **PRESERVE but content changes** — see §7 |
| `add-dashboard-btn` | Add new dashboard button | **PRESERVE** |
| `desktop-dashboard` | Default desktop dashboard select | **PRESERVE** |
| `mobile-dashboard` | Default mobile dashboard select | **PRESERVE** |
| `export-layout-btn` | Export button | **PRESERVE** |
| `import-layout-btn` | Import button | **PRESERVE** |
| `import-layout-file` | File input | **PRESERVE** |

### 2.6 Section content IDs (form fields — must survive)

All form field `name` attributes and `id` attributes used by `loadSettings()` (L37-44) and the submit handler (L3235-3239) must be **preserved exactly**. Key ones:

| ID / Name | Section |
|---|---|
| `forecast-enabled`, `solar-latitude`, `solar-longitude`, `solar-tilt`, `solar-azimuth`, `solar-capacity`, `solcast-api-key`, `solcast-resource-id`, `solar-loss-factor`, `solar-install-date` | Solar |
| `test-forecast`, `forecast-test-status` | Solar |
| `save-role-metrics`, `role-metrics-container`, `role-metrics-status` | Solar (Metric Roles) |
| `savings-currency`, `savings-rate`, `savings-solar-metric` | Savings |
| `dashboard-title`, `dashboard-logo`, `dashboard-favicon` | Branding |
| `network-local-url`, `network-remote-url` | Network |
| `backup-btn`, `restore-btn`, `restore-file` | Backup |
| `snapshot-list`, `snapshot-status` | Backup |
| `metrics-search`, `metrics-table`, `metrics-table-body`, `create-metric-btn` | Metrics |

### 2.7 Modal IDs (must survive)

| ID | Usage |
|---|---|
| `metric-modal`, `new-metric-name`, `new-metric-unit`, `modal-cancel`, `modal-create` | Metric creation modal |
| `bms-scan-modal`, `bms-scan-list`, `bms-scan-status`, `bms-scan-cache-badge` | BMS BLE scan modal |

### 2.8 IDs that CHANGE in the new HTML

| Old ID | New ID | Reason |
|---|---|---|
| `stg-shell` | `app-shell` | v2 layout class |
| `stg-sidebar` | `sidebar` | v2 naming |
| `stg-nav` | `sidebar-nav` | v2 naming |
| `stg-nav-btn` (class) | `nav-item` (class) | v2 naming |
| `stg-main` | `main-content` | v2 naming |
| `stg-section` (class) | `settings-section` (class) | v2 naming |
| `stg-subnav` (class) | `subnav` (class) | v2 naming |
| `stg-subnav-btn` (class) | `subnav-btn` (class) | v2 naming |
| `sub-tab-content` (class) | `subtab-content` (class) | v2 naming |
| `stg-card` (class) | `card` (class) | v2 naming |
| `stg-section-header` (class) | `section-header` (class) | v2 naming |
| `stg-form-row` (class) | `form-row` (class) | v2 naming |
| `stg-form-group` (class) | `form-group` (class) | v2 naming |
| `stg-input` (class) | `input` (class) | v2 naming |
| `stg-select` (class) | `select-input` (class) | v2 naming |
| `stg-savebar` (class/ID) | N/A | **Moved** — save button lives in sidebar footer or toast |
| `stg-dirty-count` | N/A | **Removed/replaced** |
| `data-source-subtabs` | `data-source-subnav` | v2 naming |
| `stg-device` (class) | `device-card` (class) | v2 naming |
| `device-card` (old JS class) | (stays same in JS — JS builds `.device-card` already, CSS just needs to match) | ✅ No JS change needed |
| `section-*` (old: `stg-section-*`) | `section-*` (new prefix) | Section nav JS updates accordingly |

---

## 3. CSS Tokens Needed in `style.css`

The v2 mockup uses these tokens **not currently present** in `public/style.css`. Add them:

```css
:root {
  /* New tokens required by v2 design */
  --text-tertiary: var(--stone-300);
  --accent-hover: var(--amber-500);
  --accent-light: var(--amber-100);
  --success: #6b8e42;           /* olive-600 */
  --success-light: #e6ede0;     /* olive-100 approximation */
  --info: var(--sky-500);
  --info-light: #f0f4f8;        /* sky-50 approximation */
  --danger: #dc2626;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.04);
  --shadow-md: 0 4px 6px rgba(0,0,0,.07), 0 2px 4px rgba(0,0,0,.06);
  --touch-target: 44px;
}

[data-theme="dark"] {
  --text-tertiary: #787670;
  --accent-hover: var(--amber-400);
  --accent-light: rgba(245,158,11,.12);
  --success: #84a45a;
  --success-light: rgba(107,142,66,.2);
  --info: var(--sky-500);
  --info-light: rgba(135,174,200,.12);
  --danger: #dc2626;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.2);
  --shadow-md: 0 4px 6px rgba(0,0,0,.3), 0 2px 4px rgba(0,0,0,.2);
}
```

Also add all the v2 CSS classes to `style.css` (append them, don't remove existing `stg-*` classes initially — see §5 for migration strategy):

- Layout: `.app-shell`, `.sidebar`, `.main-content`, `.mobile-overlay`, `.hamburger`, `.mobile-header`
- Sidebar: `.sidebar-header`, `.sidebar-logo`, `.sidebar-search`, `.search-wrap`, `.search-input`, `.sidebar-nav`, `.nav-group`, `.nav-group-header`, `.nav-group-items`, `.nav-item`, `.sidebar-footer`, `.theme-toggle`, `.back-link`
- Main content: `.breadcrumb`, `.settings-section`, `.section-header`, `.subnav`, `.subnav-btn`, `.subtab-content`
- Cards/forms: `.card`, `.card-header`, `.card-title`, `.form-row`, `.form-group`, `.input`, `.select-input`, `.toggle-wrap`, `.toggle-switch`
- Buttons: `.btn`, `.btn-primary`, `.btn-success`, `.btn-danger`, `.btn-sm`, `.btn-group`
- Devices: `.device-grid`, `.device-card`, `.device-card-header`, `.device-card-body`, `.device-card-status`, `.device-card-name`, `.device-card-type`, `.device-card-arrow`
- Misc: `.toolbar`, `.table-wrap`, `.test-row`, `.test-status`, `.section-divider`, `.empty-state`, `.info-banner`, `.help-accordion`, etc.
- Dashboard: `.dashboard-summary`, `.block-preview-list`, `.block-preview-chip`
- Responsive: `@media (max-width: 768px)` rules for mobile sidebar overlay

---

## 4. JS Changes Map

### 4.1 Functions that STAY (no changes needed)

These functions operate on container IDs and CSS classes that won't change (device cards use `.device-card` which stays the same, and `stg-*` internal classes within cards are built by JS, not touched by the CSS migration):

- `loadSettings()` — fetches APIs, calls all builders ✅
- `showStatus()` / `showStatusHtml()` ✅
- `createMetricDropdown()` ✅
- `getAllUsedMetrics()` — queries `.device-card .metric-row .metric-name` which stays ✅
- `syncAllMetricDropdowns()` ✅
- `generateMetricOptionsHtml()` ✅
- `refreshAllMetricDropdowns()` ✅
- `buildHaDeviceList()` / `renderHaDevice()` / `renderHaMappings()` / `reindexHa()` ✅
- `buildMqttDeviceList()` / `renderMqttDevice()` / `reindexMqtt()` ✅
- `buildModbusDeviceList()` / `renderModbusDevice()` / `reindexModbus()` ✅
- `buildRs232DeviceList()` / `renderRs232Device()` / `reindexRs232()` ✅
- `buildExternalSourceList()` / `renderExternalSource()` / `reindexExternal()` ✅
- `buildBmsDeviceList()` / `renderBmsDevice()` / `reindexBms()` ✅
- `buildBmsBankList()` / `renderBmsBank()` / `reindexBmsBanks()` ✅
- `buildDongleDeviceList()` / `renderDongleDevice()` / `reindexDongle()` ✅
- `buildPvoutputConfig()` ✅
- `collectPvoutputConfig()` ✅
- `collectDeviceArray()` ✅
- `collectRs232Config()` ✅
- `escapeHtml()` ✅
- Form submit handler (L3232-3386) ✅
- All "Add" button click handlers ✅
- PVOutput test/backfill/queue handlers ✅
- Metric modal handlers ✅
- BMS scan modal handlers ✅
- Role metrics save handler ✅
- Export/import layout handlers ✅

### 4.2 Functions that CHANGE

| Function | Change | Detail |
|---|---|---|
| `buildDashboardEditor(config)` | **Simplify** — remove inline block editor | Keep dashboard name list + active buttons + delete. Replace `renderDashboardBlockEditor()` call with block inventory summary. See §7. |
| `renderDashboardBlockEditor(dashboard)` | **Remove** (or gut) | No longer renders inline block config panels. v2 shows only a block-type chip list + link to `/editor`. |
| `populateDashboardSelects(config, savedDesktop, savedMobile)` | No code change | IDs `desktop-dashboard` and `mobile-dashboard` preserved, function just populates `<select>` elements by ID. ✅ |

### 4.3 Functions that are REMOVED

None are removed entirely — `renderDashboardBlockEditor` is gutted but the container `active-dashboard-editor` still needs content populated. The function is replaced with a simpler one that renders the block inventory summary.

### 4.4 New JS needed (in settings.html inline or settings.js)

The v2 mockup's inline JS provides:
- Mobile sidebar open/close (hamburger, overlay, close button)
- Theme toggle (reading/writing `data-theme` on `<html>`, syncing localStorage)
- Section navigation (`.nav-item` clicks → `.settings-section` show/hide)
- Sub-tab navigation (`.subnav-btn` clicks → `.subtab-content` show/hide)
- Global search filtering (hide nav items/groups by text match)
- Group collapse/expand (toggle nav groups open/closed)

This replaces the current settings.html inline JS (L738-1050). The new inline JS must:
1. Keep the same **variable names** (`stgForm`, `saveBtn`, `saveStatusEl`, `dirtyCount`) for the save bar if it persists
2. Keep the same **localStorage keys** (`stg-active-section`, `stg-active-subtab`) or rename them and add migration
3. Keep the same **event dispatch** (`stg-save-complete` custom event)
4. Keep backup/restore handlers referencing the same IDs
5. Keep snapshot loading logic
6. Keep mappings filter + pagination

### 4.5 Critical: `device-card` class conflict resolution

**JS builds elements with class `.device-card`** — this class name is the SAME in both old and new code. The v2 CSS redefines `.device-card` with a slightly different style (grid layout, card-header vs device-bar). This means:

- **CSS only**: Update `style.css` to use v2's `.device-card` / `.device-card-header` / `.device-card-body` classes
- **JS unchanged**: The JS already creates elements appropriate for the new CSS since it uses generic class names like `device-header`, `device-card`, etc.
- **One gotcha**: Old CSS uses `.stg-device` class while JS uses `.device-card`. Double-check that both are not applied simultaneously. Solution: remove old `.stg-device*` CSS rules and keep v2 `.device-card*` rules.

---

## 5. HTML Changes — Rewrite Strategy

### Strategy: **Full rewrite of `settings.html`**

A patch-in-place approach is too risky given the scope of changes (every CSS class, the layout shell, the sidebar structure, the section IDs). The cleanest approach:

1. **Backup** current `settings.html` as `settings.html.bak`
2. **Write new `settings.html`** with:
   - v2's HTML structure (sidebar + main-content)
   - v2's CSS imported from `style.css` (not embedded — remove the `<style>` block from the mockup)
   - All **preserved IDs** from §2 above
   - All **preserved form field names** from current HTML
   - v2's navigation groups (4 groups, categorized)
   - v2's inline JS (adapted to preserve current functionality)
   - `#settings-form` wrapping all content sections (keep existing form structure)
   - Bottom save bar preserved (`#stg-savebar`, `#stg-dirty-count`, `#stg-save-btn`)
3. **Keep** `<script src="/js/csrf.js"></script>` and `<script src="settings.js"></script>` at bottom
4. **Remove** `<style>` block — all CSS goes into `style.css`

### What STAYS the same (in new HTML):

- Form field names (`name="..."` attributes) — all identical
- Device container IDs — all identical
- Sub-tab content IDs (`subtab-ha`, `subtab-mqtt`, etc.) — all identical
- PVOutput field IDs — all identical
- Dashboard select IDs (`desktop-dashboard`, `mobile-dashboard`, `dashboards-list`, `active-dashboard-editor`, `add-dashboard-btn`)
- Section form field IDs (`forecast-enabled`, `solar-latitude`, etc.)
- Modal HTML (metric-modal, bms-scan-modal) — copy verbatim
- Save bar HTML — copy verbatim
- Help section accordion HTML — copy with updated CSS class names

### What CHANGES:

| Element | Old | New |
|---|---|---|
| Root layout div | `<div class="stg-shell">` | `<div class="app-shell">` |
| Sidebar | `<nav class="stg-sidebar">` with flat `<ul class="stg-nav">` | `<nav class="sidebar" id="sidebar">` with grouped `<div class="nav-group">` structure |
| Sidebar nav items | 9 flat `<button class="stg-nav-btn">` | 8 items in 4 groups with `<button class="nav-item">` |
| Search | Help section only | Global sidebar search (`#global-search`) + help section search |
| Main content | `<main class="stg-main" id="stg-main">` | `<main class="main-content" id="main-content">` |
| Sections | `<section class="stg-section" id="stg-section-*">` | `<section class="settings-section" id="section-*">` |
| Cards | `<div class="stg-card">` | `<div class="card">` |
| Form rows/groups | `stg-form-row`, `stg-form-group` | `form-row`, `form-group` |
| Inputs/selects | `stg-input`, `stg-select` | `input`, `select-input` |
| Sub-navigation | `<div class="stg-subnav" id="data-source-subtabs">` + `stg-subnav-btn` | `<div class="subnav" id="data-source-subnav">` + `subnav-btn` |
| Sub-tab content | `<div class="sub-tab-content" id="subtab-*">` | `<div class="subtab-content" id="subtab-*">` (class name only) |
| Section headers | `<div class="stg-section-header"><h2>` | `<div class="section-header"><h1>` |
| Breadcrumb | None | Added: `<div class="breadcrumb"><span>Group</span> / Section</div>` per section |
| Theme toggle | In sidebar footer | In sidebar footer (same location, new classes) |
| Mobile support | None | Hamburger button, mobile overlay, mobile header, responsive sidebar |

---

## 6. Risk Register

| Risk | Severity | Impact | Mitigation |
|---|---|---|---|
| **CSS class name collision** — `style.css` already has `.device-card` rules from the old `stg-*` system and v2 introduces new `.device-card` rules | **HIGH** | Device card styling breaks, layout mangled | Audit `style.css` for all `.device-card` references. Add new rules with v2 prefix temporarily, then remove old rules once verified. |
| **Form field `name` mismatch** — `loadSettings()` iterates `form.querySelectorAll('[name="..."]')` | **HIGH** | Settings don't populate on load | Exhaustive grep of every `name="..."` in old HTML, verify all present in new HTML. |
| **`collectDeviceArray()` breakage** — uses container ID + `.device-card` class + internal selectors | **HIGH** | Save submits empty device arrays | Container IDs preserved. Internal selectors like `.device-header input[type="text"]` must still match. Verify the rename from `.stg-device` to `.device-card` doesn't break anything. |
| **Inline JS variable collisions** — old inline JS defines `stgForm`, `navBtns`, `sections`, etc. New inline JS defines different vars | **MEDIUM** | JS errors on load | Complete rewrite of inline JS. Keep only the global references needed by settings.js (form submit listener, save button, dirty count). |
| **`switchSection()` / `switchSubTab()` gone** — these functions are defined in current inline JS and called from help links (`javascript:switchSection('solar')`) | **MEDIUM** | Help section links break | Replace `javascript:switchSection()` calls with v2's `navigateTo()` or inline `activateSection()`. Update all help accordion links. |
| **localStorage key changes** — old uses `stg-active-section`, v2 uses `epilykos-settings-section` | **LOW** | Users lose their last-viewed section on first load | Add migration code: read old key, write to new key, delete old key. |
| **Theme localStorage key** — old uses `theme`, v2 uses `epilykos-theme` | **LOW** | Theme resets to default | Add migration: read old `theme` key, write to `epilykos-theme`. |
| **Backup/snapshot JS in settings.html** — inline JS handles backup download, restore upload, snapshot list rendering | **MEDIUM** | Backup/restore buttons stop working | Preserve the backup/restore/snapshot JS verbatim in new inline script. |
| **Mappings filter/pagination JS** — inline JS handles mapping search + "Show more" pagination | **MEDIUM** | Large mapping lists become unusable | Preserve the filter/pagination JS and its `MutationObserver`. CSS class names for filter input (`mappings-filter-input`) must be preserved. |
| **`stg-dirty-count` display** — save bar shows unsaved changes count | **LOW** | Save bar appears broken | Preserve the save bar HTML and JS exactly. The `stg-save-complete` custom event listener must still work. |
| **BMS scan modal** — uses `stg-modal` class, `bms-scan-*` classes | **LOW** | BMS scan UI looks wrong | Update modal CSS classes to v2 equivalents but keep the JS logic identical. |

---

## 7. Dashboard Editor Migration

### Current state
The Dashboard section has:
1. **Dashboard list** (`#dashboards-list`) — name, Set Active, Delete buttons
2. **Default selects** (`#desktop-dashboard`, `#mobile-dashboard`)
3. **Inline block editor** (`#active-dashboard-editor`) — full block config UI: type dropdown, width, height, per-block config panels with metric selects, save buttons
4. **Display settings** — transparent blocks, bg colors, bg image, grid status metric
5. **Export/Import layout** buttons

### v2 target state
1. **Dashboard list** — same, but styled as a table with Name, Blocks (count), Default, Actions columns
2. **Default selects** — same
3. **Block Inventory** (`#active-dashboard-editor`) — **no longer renders inline block editor**. Instead shows:
   - Block type chip previews (e.g., "Flow Card", "Forecast Card", "Metric Row", "Solar Gauge", "System Info")
   - Note: "Block editing has moved to the dedicated Editor page"
   - Link/button: "Open in Editor →"
4. **Display settings** — same
5. **Export/Import layout** — same

### JS changes needed

```javascript
// OLD: buildDashboardEditor() calls renderDashboardBlockEditor(activeDb)
// NEW: buildDashboardEditor() calls renderBlockInventory(activeDb)

function buildDashboardEditor(config) {
  dashConfig = config || { dashboards: [], activeDashboard: 'main' };
  const listEl = document.getElementById('dashboards-list');
  listEl.innerHTML = '';
  if (!dashConfig.dashboards.length) return;
  const activeId = dashConfig.activeDashboard || dashConfig.dashboards[0]?.id;
  dashConfig.dashboards.forEach(db => {
    // ... (same dashboard list rendering as before)
  });
  const activeDb = dashConfig.dashboards.find(db => db.id === activeId);
  if (activeDb) renderBlockInventory(activeDb);  // CHANGED
}

// NEW function — replaces renderDashboardBlockEditor()
function renderBlockInventory(dashboard) {
  const container = document.getElementById('active-dashboard-editor');
  const blocks = dashboard.layout || [];
  
  // Count blocks by type
  const typeCounts = {};
  const typeIcons = {
    'flow-card': '◉', 'flow-card-2': '◎', 'flow-card-square': '◉', 'flow-card-square-2': '◎',
    'forecast-banner': '☷', 'forecast-sparkline': '☷', 'forecast-info': '☷', 'forecast-pvtoday': '☷',
    'metric-cards': '≡', 'multi-value': '≡',
    'gauge-card': '◔', 'half-gauge': '◔', 'half-gauge-2': '◔', 'bar-gauge': '▬', 'bar-gauge-retro': '▬',
    'chart-power': '📈', 'chart-energy': '📊',
    'grid-card': '⊞', 'battery-block': '⊟',
    'savings-summary': '💰', 'data-table-daily': '📋', 'data-table-monthly': '📋',
    'text-card': '📝', 'iframe-card': '🌐', 'system-info': '⌂'
  };
  
  blocks.forEach(b => {
    const t = b.type || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  
  const chips = Object.entries(typeCounts).map(([type, count]) => {
    const icon = typeIcons[type] || '●';
    return `<div class="block-preview-chip"><span class="chip-icon">${icon}</span> ${count}× ${type}</div>`;
  }).join('');
  
  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Block Inventory — ${blocks.length} block${blocks.length !== 1 ? 's' : ''}</span>
        <a href="/editor" class="btn btn-sm btn-primary">Open in Editor →</a>
      </div>
      <div class="block-preview-list">${chips || '<div class="empty-state"><p>No blocks yet. Add them in the Editor.</p></div>'}</div>
      <p class="note" style="margin-top:0.5rem;font-size:0.775rem;">
        Block editing has moved to the dedicated <a href="/editor" style="color:var(--accent);font-weight:600;">Editor page</a> for a full drag-and-drop experience with visual previews.
      </p>
    </div>
  `;
}
```

**Remove**: `renderDashboardBlockEditor()` entirely (~400 lines of block config panel rendering, L2526-2920).

---

## 8. Implementation Order (Recommended)

### Phase A: CSS Foundation (lowest risk)
1. Add new CSS tokens to `style.css` (`--text-tertiary`, `--accent-hover`, `--accent-light`, `--success`, `--success-light`, `--info`, `--info-light`, `--danger`, `--shadow-sm`, `--shadow-md`, `--touch-target`)
2. Append all v2 CSS classes to `style.css` (after existing `stg-*` rules)
3. Verify existing settings page still renders correctly (new CSS classes are unused by old HTML)
4. Test light/dark theme

### Phase B: settings.js Refactor (moderate risk)
1. Replace `renderDashboardBlockEditor()` with `renderBlockInventory()` 
2. Add the new function
3. Test: verify dashboard section shows block chips instead of inline editor
4. Verify save still works (dashboard_config serialization unchanged)

### Phase C: HTML Rewrite (highest risk)
1. Backup `settings.html`
2. Write new `settings.html` with v2 structure, all preserved IDs, all preserved form field names
3. Copy modal HTML verbatim
4. Copy save bar HTML verbatim
5. Write new inline JS:
   - Mobile sidebar toggle
   - Theme toggle (with localStorage migration)
   - Section navigation (with localStorage migration)
   - Sub-tab navigation
   - Global search
   - Group collapse/expand
   - Save button → form submit
   - Dirty state tracking
   - Metrics search
   - Backup/restore handlers
   - Snapshot loading
   - Mappings filter/pagination
   - Help search
6. Update help section links (`javascript:switchSection()` → `activateSection()`)
7. Test: load page, navigate all sections, verify all device builders work
8. Test: save settings, verify all data persists
9. Test: dark/light theme toggle
10. Test: mobile responsive (hamburger menu, overlay)

### Phase D: Cleanup
1. Remove old `stg-*` CSS rules from `style.css` that are fully replaced by v2 equivalents
2. Remove `settings.html.bak`

---

## 9. Files Changed Summary

| File | Type | Lines affected |
|---|---|---|
| `public/style.css` | Append | ~500 lines of new CSS + ~20 lines of tokens |
| `public/settings.html` | Rewrite | Full rewrite (~600 lines new HTML) |
| `public/settings.js` | Edit | Replace `renderDashboardBlockEditor()` (~400 lines removed, ~60 lines added) |

Total: ~3 files changed. No API changes. No backend changes. No new files.

---

## 10. Testing Checklist

- [ ] Page loads without JS errors in console
- [ ] All 9 sections navigate correctly via sidebar
- [ ] Sidebar search filters nav items
- [ ] Sidebar groups collapse/expand
- [ ] Dark/light theme toggle works and persists
- [ ] Data Sources → all 8 sub-tabs switch correctly
- [ ] HA device: add, configure, fetch entities, add mappings, remove
- [ ] MQTT device: add, configure, test broker, discover topics, remove
- [ ] Modbus device: add, configure, load profile fields, remove
- [ ] RS232 device: add, configure, load profile fields, remove
- [ ] External source: add, configure, add mappings, remove
- [ ] BMS device: add, configure, scan BLE, remove
- [ ] BMS bank: add, configure functions, remove
- [ ] Dongle: add, configure, load registers, remove
- [ ] PVOutput: configure, test connection, metric mapping, queue controls
- [ ] Metrics: table loads, filter works, create new metric
- [ ] Solar: configure forecast, test forecast, metric roles save
- [ ] Dashboard: dashboard list, default selects, block inventory shows chips, "Open in Editor" link works
- [ ] Savings: fields populate and save
- [ ] Branding: fields populate and save
- [ ] Backup: download, restore, snapshot list, snapshot restore
- [ ] Network: fields populate and save
- [ ] Help: search filters accordions, all links work
- [ ] Save bar: dirty count shows, "Save All Settings" works
- [ ] Mobile responsive: hamburger opens sidebar, overlay closes it, nav item click closes sidebar
- [ ] All form fields populate correctly from `/api/settings`
- [ ] All form fields save correctly to `/api/settings`
- [ ] No 404s for CSS/JS resources
- [ ] No visual regressions in device cards, mapping tables, modals
