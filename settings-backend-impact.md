# Epilykos Settings Page Redesign — Backend Impact Assessment

> **Author:** Linus (Full-Stack Developer)  
> **Date:** 2026-07-19  
> **Scope:** Backend API, data model, and migration analysis for settings page redesign

---

## 1. Current Architecture Overview

### 1.1 Data Flow Diagram (Text)

```
┌─────────────────────────────────────────────────────────────────┐
│                   SETTINGS PAGE (settings.html)                  │
│                                                                   │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │ Sidebar Nav  │   │ 9 <section>  │   │ Save Bar (persistent) │ │
│  │  9 buttons   │   │  elements    │   │   [Save All Settings] │ │
│  │ data-section=│   │ toggled by   │   │                      │ │
│  │  attr        │   │ class=active │   │                      │ │
│  └──────────────┘   └──────┬───────┘   └──────────┬───────────┘ │
│                             │                       │             │
│  Sub-tabs within            │                       │             │
│  Data Sources: HA, MQTT,    │                       │             │
│  Modbus, RS232, REST,       │                       │             │
│  BMS, Dongle, PVOutput      │                       │             │
└─────────────────────────────┼───────────────────────┼───────────┘
                              │                       │
                    GET /api/settings          POST /api/settings
                    (load on page init)       (monolithic save)
                              │                       │
                    ┌─────────▼───────────────────────▼──────────┐
                    │              server.js                       │
                    │                                              │
                    │  GET /api/settings                          │
                    │    → SELECT key,value FROM config           │
                    │    → returns flat JSON: {key:val, ...}      │
                    │                                              │
                    │  POST /api/settings                         │
                    │    → receives full payload JSON             │
                    │    → filters sensitive keys (token,passwd)  │
                    │    → INSERT OR REPLACE into config          │
                    │    → triggers service restarts based on     │
                    │      which keys changed                     │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────────┐
                    │              SQLite (energy.db)              │
                    │                                              │
                    │  config table:                               │
                    │    key    TEXT PRIMARY KEY                   │
                    │    value  TEXT                               │
                    │                                              │
                    │  Key categories stored:                     │
                    │  ┌───────────────────────────────────┐     │
                    │  │ ha_devices        → JSON array    │     │
                    │  │ mqtt_devices      → JSON array    │     │
                    │  │ modbus_devices    → JSON array    │     │
                    │  │ rs232_devices     → JSON array    │     │
                    │  │ external_sources  → JSON array    │     │
                    │  │ bms_devices       → JSON array    │     │
                    │  │ bms_banks         → JSON array    │     │
                    │  │ dongle_config     → JSON array    │     │
                    │  │ pvoutput_config   → JSON object   │     │
                    │  │ dashboard_config  → JSON object   │     │
                    │  │                    (giant blob)   │     │
                    │  │ user_metrics      → JSON array    │     │
                    │  │ role_metrics      → JSON object   │     │
                    │  │ forecast_enabled  → "true"/"false"│     │
                    │  │ solar_latitude,   → strings/num  │     │
                    │  │ solar_longitude,                 │     │
                    │  │ solar_capacity_kwp,etc.          │     │
                    │  │ savings_currency, → strings      │     │
                    │  │ savings_rate                     │     │
                    │  │ dashboard_title,  → strings      │     │
                    │  │ dashboard_logo, etc.              │     │
                    │  │ transparent_blocks → "true"/false │     │
                    │  │ desktop_dashboard → string        │     │
                    │  │ mobile_dashboard  → string        │     │
                    │  │ network_local_url,→ strings      │     │
                    │  │ network_remote_url                │     │
                    │  │ external_poll_interval → string  │     │
                    │  │ rs232_poll_interval → string     │     │
                    │  │ grid_status_entity → string      │     │
                    │  │ pvoutput_stats_cache → JSON      │     │
                    │  │ pvoutput_rate_limit_state → JSON │     │
                    │  └───────────────────────────────────┘     │
                    └──────────────────────────────────────────────┘
```

### 1.2 Current Page Structure (9 Top-Level Sections)

| Section | `data-section` | Key UI Elements | Backend Keys |
|---------|---------------|-----------------|-------------|
| Data Sources | `data-sources` | 8 sub-tabs (HA, MQTT, Modbus, RS232, REST, BMS, Dongle, PVOutput) | `ha_devices`, `mqtt_devices`, `modbus_devices`, `rs232_devices`, `external_sources`, `bms_devices`, `bms_banks`, `dongle_config`, `pvoutput_config`, `external_poll_interval`, `rs232_poll_interval` |
| Metrics | `metrics` | Table view + create/delete | `user_metrics` |
| Solar | `solar` | Forecast config + role metrics | `forecast_enabled`, `solar_latitude`, `solar_longitude`, `solar_tilt`, `solar_azimuth`, `solar_capacity_kwp`, `solcast_api_key`, `solcast_resource_id`, `solar_loss_factor`, `solar_install_date`, `role_metrics` |
| Dashboard | `dashboard` | Dashboard tabs, block editor, display settings | `dashboard_config`, `desktop_dashboard`, `mobile_dashboard`, `transparent_blocks`, `dashboard_bg_color_light`, `dashboard_bg_color_dark`, `dashboard_bg_image`, `grid_status_entity` |
| Savings | `savings` | Currency, rate, solar metric | `savings_currency`, `savings_rate`, `savings_solar_metric` |
| Backup | `backup` | Download/restore + snapshots | (none — uses separate endpoints) |
| Branding | `branding` | Title, logo, favicon | `dashboard_title`, `dashboard_logo`, `dashboard_favicon` |
| Network | `network` | LAN/remote URLs | `network_local_url`, `network_remote_url` |
| Help | `help` | Static docs | (none) |

---

## 2. API Surface Affected

### 2.1 Current Settings Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/settings` | GET | Session | Returns all config as flat `{key: value}` JSON |
| `/api/settings` | POST | Session | Saves entire config payload; triggers service restarts |
| `/api/metrics/list` | GET | Session | Returns all metric names, values, units, timestamps |
| `/api/metrics/create` | POST | Session | Creates a new metric |
| `/api/metrics/:name` | DELETE | Session | Deletes a metric |

### 2.2 Device-Specific Test/Discovery Endpoints (Affected by Context)

| Endpoint | Method | Data Source Key | Notes |
|----------|--------|----------------|-------|
| `/api/ha-device-entities` | GET | `ha_devices` | Fetches HA entities (url+token via query params) |
| `/api/test-mqtt` | GET | `mqtt_devices` | Tests broker connection |
| `/api/test-mqtt-topic` | GET | `mqtt_devices` | Tests a topic subscription |
| `/api/mqtt-discover-topics` | GET | `mqtt_devices` | Wildcard topic discovery |
| `/api/modbus/profiles` | GET | `modbus_devices` | Lists available profiles |
| `/api/modbus/profile/:id` | GET | `modbus_devices` | Gets profile details |
| `/api/test-modbus` | POST | `modbus_devices` | Tests modbus connection |
| `/api/rs232/profiles` | GET | `rs232_devices` | Lists available RS232 profiles |
| `/api/rs232/profile/:id` | GET | `rs232_devices` | Gets RS232 profile details |
| `/api/rs232/ports` | GET | `rs232_devices` | Lists available serial ports |
| `/api/test-rs232` | POST | `rs232_devices` | Tests RS232 connection |
| `/api/test-external` | POST | `external_sources` | Tests REST API source |
| `/api/bms/scan` | GET | `bms_devices` | Scans for BLE BMS devices |
| `/api/bms/test` | GET | `bms_devices` | Tests a BMS device |
| `/api/bms/bank/test` | POST | `bms_banks` | Tests bank aggregation |
| `/api/bms/device-metrics/:name` | GET | `bms_devices` | Gets available source keys |
| `/api/dongle/profiles` | GET | `dongle_config` | Lists dongle profiles |
| `/api/dongle/profile/:id` | GET | `dongle_config` | Gets profile details |
| `/api/dongle/test` | POST | `dongle_config` | Tests dongle connection |
| `/api/dongle/status` | GET | `dongle_config` | Gets dongle status |
| `/api/pvoutput/*` | various | `pvoutput_config` | PVOutput integration suite |
| `/api/test-forecast` | GET | forecast keys | Tests solar forecast |

### 2.3 Dashboard-Specific Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/dashboard-config` | GET | Public | Returns dashboard layout |
| `/api/dashboard-config` | POST | Session | Saves dashboard layout |
| `/api/dashboard-config/export` | GET | Session | Downloads layout JSON |
| `/api/dashboard-config/import` | POST | Session | Imports layout JSON |
| `/api/role-metrics` | GET/POST | Session | System role→metric mapping |
| `/api/public-config` | GET | Public | Public branding/display config |

---

## 3. Current Save Flow Analysis

### 3.1 Frontend Save (settings.js, lines 3232–3386)

```
form submit event
  ↓
collectDeviceArray("ha-devices-container", ...) → JSON.stringify(arr)
collectDeviceArray("mqtt-devices-container", ...) → JSON.stringify(arr)
collectDeviceArray("modbus-devices-container", ...) → JSON.stringify(arr)
collectDeviceArray("rs232-devices-container", ...) → JSON.stringify(arr)
collectDeviceArray("external-sources-container", ...) → JSON.stringify(arr)
collectDeviceArray("bms-devices-container", ...) → JSON.stringify(arr)
collectDeviceArray("bms-banks-container", ...) → JSON.stringify(arr)
collectDeviceArray("dongle-devices-container", ...) → JSON.stringify(arr)
collectPvoutputConfig() → JSON.stringify(obj)
  ↓
form.querySelectorAll('input[name],select[name],textarea[name]') → flat key-value pairs
  [skips names starting with ha_devices[, mqtt_devices[, modbus_devices[, 
   rs232_devices[, external_sources[, bms_devices[, bms_banks[, dongle_config[,
   and dashboard_config (handled separately)]
  ↓
payload = {...flatPairs, ha_devices, mqtt_devices, ..., dashboard_config: JSON.stringify(dashConfig), pvoutput_config: JSON.stringify(pvoutputConfig)}
  ↓
POST /api/settings  { Content-Type: application/json, body: JSON.stringify(payload) }
```

### 3.2 Backend Save (server.js, lines 902–957)

```
POST /api/settings
  ↓
filters keys matching /token|password|secret|key|auth|credential/i (rejects them)
  ↓
INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
  [ALL values are converted to String(value)]
  ↓
Post-save side effects (conditional restart):
  - 'mqtt_devices' in payload → restartMqtt()
  - 'external_sources' or 'external_poll_interval' → restartExternalPolling()
  - 'bms_devices' → restartBmsPolling()
  - 'bms_banks' → cleanupOrphanedBankMetrics() + auto-create bank_* metrics + restartBmsPolling()
  - 'dongle_config' → restartDonglePolling()
  - 'pvoutput_config' → pvoutput.restart()
  - 'rs232_devices' → restartRs232Streaming()
  - forecast keys → (currently no effect — cache reset commented out)
```

### 3.3 Critical Observations

1. **Monolithic save**: The entire settings state is posted as one JSON payload. There is no per-section save.

2. **No transactional semantics**: If the POST fails mid-way through the INSERT/REPLACE loop, some keys will be updated and others won't — no rollback.

3. **No input validation beyond sensitive key filtering**: JSON arrays/objects are stored as-is. Malformed data that fails to parse would cause runtime errors in polling modules.

4. **Key ordering matters**: `bms_banks` processing calls `cleanupOrphanedBankMetrics` which compares old vs new banks. The old value is read with `getConfig()` (which may already be the new value if `bms_banks` was processed first).

5. **Save is all-or-nothing on the frontend**: There's no way to save just one section — the frontend always collects and posts everything.

---

## 4. What Would Break If Navigation Changes

### 4.1 Navigation Architecture

The current navigation is:
```
HTML Sidebar (<nav class="stg-sidebar">)
  └─ <ul class="stg-nav">
       └─ 9 × <li><button data-section="X">
  
HTML Main (<main class="stg-main">)
  └─ 9 × <section class="stg-section" id="stg-section-X">
       └─ Data Sources section has sub-tabs (8 × <button data-subtab="Y"> + <div class="sub-tab-content">)

Navigation logic (inline <script> in settings.html):
  - switchSection(sectionId) → toggles .active on nav buttons and sections
  - switchSubTab(subId) → toggles .active on sub-tab buttons and content divs
  - Persists active section/subtab in localStorage
```

### 4.2 Impact Analysis by Navigation Change Type

| Change | Impact | Risk Level |
|--------|--------|------------|
| **Renaming sections** (e.g., "Solar" → "Forecast") | Minimal — only affects HTML `<section>` IDs and `data-section` attributes. `settings.js` load logic doesn't reference section names directly except for the `stg-section-solar` MutationObserver (line 2382). | Low |
| **Moving sections to a different order** | No backend impact. Pure CSS/HTML reorder. `settings.js` builds all data structures at load time regardless of visibility. | None |
| **Splitting Data Sources into separate top-level sections** | The 8 sub-tabs currently live under one `<section>`. Moving them to individual top-level sections requires: (a) restructuring HTML, (b) updating `switchSection()` logic, (c) potentially removing sub-tab logic. **No API changes needed** — same device containers just render in different sections. | Medium (frontend work) |
| **Adding new settings sections** | If new sections need new config keys: add keys to `database.js` essential keys list, ensure save flow includes them (automatic if using `<input name="...">` in the form). | Low |
| **Removing a section** | Ensure its config keys are preserved in DB (don't delete on migration). The settings GET/POST still works — keys not in the form are ignored on save since they're not in the POST body. | Low |
| **Changing from section-based to wizard/multi-step** | Would need a way to save partial state. **Current backend cannot handle partial saves cleanly** — it saves whatever keys are in the POST body. If a wizard step omits device arrays, those keys wouldn't be in the payload and would be preserved (correct behavior). But the monolithic save expects all data at once. | High |
| **Tree navigation instead of flat list** | Same as section changes — backend is agnostic to navigation structure. | None |
| **Search-based or command-palette navigation** | Backend unchanged. | None |

### 4.3 Hidden Dependencies

- **MutationObserver on `stg-main`** (line 2386-2387): Watches for class changes to lazy-load role metrics when the Solar section becomes visible. If section DOM structure changes, this observer must be updated.
- **`localStorage` keys** (`stg-active-section`, `stg-active-subtab`): If section IDs change, restore logic needs migration.
- **Help section `switchSection('solar')` and `switchSubTab('modbus')` calls**: Hardcoded inline in HTML. Must be updated if section/subtab IDs change.

---

## 5. Dashboard Config Blob — Split Potential

### 5.1 Current `dashboard_config` Structure

```json
{
  "dashboards": [
    {
      "id": "main",
      "name": "Default",
      "layout": [
        {
          "id": "b_flow2",
          "type": "flow-card-2",
          "gridX": 0, "gridY": 0, "gridW": 4, "gridH": 12,
          "enabled": true,
          "transparent": false,
          "bgColor": "#0f172a",
          "innerBgColor": "#0f172a",
          "config": {
            "title": " ",
            "inverter_image": "https://...",
            "metrics": { "solar": "PV Power", ... }
          }
        }
      ]
    }
  ],
  "activeDashboard": "main",
  "desktop_dashboard": "main",
  "mobile_dashboard": "main",
  "transparent_blocks": false,
  "dashboard_bg_color_light": "#f8fafc",
  "dashboard_bg_color_dark": "#0f172a",
  "dashboard_bg_image": "",
  "grid_status_entity": ""
}
```

**Note:** In the actual DB, some of these are stored as SEPARATE keys (`desktop_dashboard`, `mobile_dashboard`, `transparent_blocks`, `dashboard_bg_color_light`, `dashboard_bg_color_dark`, `dashboard_bg_image`, `grid_status_entity`) but the `dashboard_config` blob also carries them. The `getDashboardConfig()` module only reads `dashboard_config` and handles it as a single JSON blob. The separate keys are consumed by `public-config` endpoint and the frontend independently.

### 5.2 Separable Concerns

| Concern | Current Location | Can Be Split? | Dependencies |
|---------|-----------------|---------------|-------------|
| **Dashboards array** (layouts, blocks) | `dashboard_config` blob | Yes — into `dashboard_layouts` or its own DB table | Editor, `getDashboardConfig()`, `saveDashboardConfig()`, dashboard.js |
| **Active dashboard** | `dashboard_config.activeDashboard` | Yes — into `active_dashboard` config key | `getDashboardConfig()`, dashboard.js |
| **Desktop/Mobile defaults** | Separate keys already | Already split | `public-config`, dashboard.js |
| **Transparent blocks** | Separate key already | Already split | `public-config`, dashboard.js |
| **Background colors** | Separate keys already | Already split | `public-config`, dashboard.js |
| **Background image** | Separate key already | Already split | `public-config`, dashboard.js |
| **Grid status entity** | Separate key | Already split | Grid polling module |
| **Block display properties** (bgColor, transparent, font) | Inside each block in layout | Could be a theme system | Editor, dashboard renderer |

### 5.3 Recommendation

The `dashboard_config` blob **can and should be split**:

1. **`dashboard_layouts`** — new config key storing ONLY the dashboards array (layouts, blocks). This is the heavyweight data (10+ KB with full configs).
2. **`dashboard_active`** — new config key storing active dashboard ID.
3. **Display settings** — already separate keys, keep them.
4. **Block configs** — keep inline with blocks (they're block-type-specific and tightly coupled).

**Benefits of splitting:**
- Dashboard layout import/export only touches layout data, not display settings.
- Active dashboard switching is a single-key write instead of re-serializing the entire blob.
- Independent editing: display settings don't risk corrupting dashboard layouts.

---

## 6. Migration Risks

### 6.1 Data That Could Be Lost

| Scenario | Data at Risk | Mitigation |
|----------|-------------|------------|
| Key renamed in DB | Old key's value lost if not migrated | Add migration in `database.js` `migrateLegacyConfig()` to copy old→new key |
| dashboard_config blob split | If new code only reads new keys, old data invisible | Dual-read: try new key first, fall back to old blob |
| Section reorganized, form fields renamed | Fields with `name="old_key"` won't map to `name="new_key"` | Keep DB keys unchanged; only change UI organization |
| New required keys added | Missing keys cause `getConfig()` to return `''` | Add to `essentialKeys` in database.js with sensible defaults |
| Sensitive key filter blocks save | Keys like `solcast_api_key` rejected silently | The filter regex `/token|password|secret|key|auth|credential/i` matches `solcast_api_key` — **this is a bug** currently causing silent drops of forecast API key |

### 6.2 Breaking Changes Matrix

| Change | Frontend Break | Backend Break | Data Migration Needed |
|--------|---------------|---------------|----------------------|
| Add new config key | No (form adds it) | No (INSERT OR REPLACE handles unknown keys) | No |
| Remove config key | No (value stays in DB, just unused) | No | No |
| Rename config key | Yes (form uses old name) | Yes (modules read old name) | Yes (copy old→new) |
| Change value format (e.g., JSON→new structure) | Yes (parsing fails) | Yes (modules read old format) | Yes (transform) |
| Split dashboard_config | Yes (old code reads blob) | Yes (`getDashboardConfig()` expects blob) | Yes (split blobs, dual-read) |
| Add new settings section | No | No | No |
| Move device type to new section | No (same containers, same keys) | No | No |

### 6.3 What Needs Backfill

| Item | Reason | Backfill Strategy |
|------|--------|-------------------|
| New config keys | Old installs missing them | `database.initializeDatabase()` INSERT OR IGNORE + default values |
| Split `dashboard_config` fields | Old blob format | Migration: parse old blob, extract individual fields, write to new keys, keep old blob as fallback |
| Renamed section IDs in localStorage | Users with old `stg-active-section` values | Migration: check for old IDs on page load, redirect to new IDs |

### 6.4 Sensitive Key Filter Bug

The POST `/api/settings` endpoint filters out keys matching `/token|password|secret|key|auth|credential/i`. This regex is **too aggressive** and blocks:

- `solcast_api_key` (matches `key`)
- `pvoutput_api_key` (if sent via settings — currently handled separately)
- Any future key containing "key" or "token" in its name

**Recommendation:** Replace with an explicit allowlist/blocklist rather than regex, or make the regex more specific:
```js
const sensitivePattern = /_token$|_password$|_secret$/i;
```

This only blocks keys ending in `_token`, `_password`, or `_secret`, not ones containing "key" like `api_key`.

---

## 7. Migration Path (Phased Approach)

### Phase 1 — Non-Breaking Quick Wins (1–2 days)

**Goal:** Reorganize navigation without changing any backend keys.

1. Restructure `settings.html` sections: reorder, rename CSS classes, add new sections.
2. Keep all `name=""` attributes on form fields unchanged.
3. Update `switchSection()` and `switchSubTab()` to match new structure.
4. Migrate `localStorage` keys: check for old section IDs, redirect to new ones.
5. **No backend changes. No data migration. Zero risk.**

### Phase 2 — Split Dashboard Config (2–3 days)

**Goal:** Decompose the `dashboard_config` blob without breaking existing data.

1. Add new config keys to `essentialKeys` in `database.js`:
   - `dashboard_layouts`
   - `dashboard_active`
2. Create migration in `migrateLegacyConfig()`:
   ```
   if old dashboard_config blob exists:
     parse it
     write dashboard_layouts = dashboards array
     write dashboard_active = activeDashboard
     keep dashboard_config (don't delete)
   ```
3. Update `dashboard-config.js` module:
   - `getDashboardConfig()` reads `dashboard_layouts` first, falls back to `dashboard_config` blob
   - `saveDashboardConfig()` writes to `dashboard_layouts` and `dashboard_active`
4. Update frontend to use new endpoints/keys.
5. After one release cycle of dual-read, remove fallback.

### Phase 3 — Per-Section Save API (3–5 days)

**Goal:** Enable independent section saves for wizard/multi-step flows.

1. Add new endpoint: `POST /api/settings/:section`
   - `:section` = `data-sources`, `solar`, `dashboard`, `savings`, `branding`, `network`
   - Each accepts only the keys relevant to that section
   - Maintains the same side-effect logic (restart services)
2. Update frontend to support both:
   - Monolithic save (current behavior, for "Save All" button)
   - Per-section save (for wizard steps or auto-save)
3. Add input validation per section (e.g., JSON parse device arrays before storing).
4. Add transaction wrapping for atomicity.

### Phase 4 — Data Model Hardening (2–3 days)

**Goal:** Improve data integrity and reduce risk.

1. Fix the sensitive key filter regex (see §6.4).
2. Add JSON schema validation for complex objects:
   - `ha_devices[]` → validate each device has `name`, `url`, `token`, `entities`
   - `modbus_devices[]` → validate `transport`, `profile`, mappings structure
3. Add DB transactions to the save flow.
4. Add version tracking to config: `config_version = N` key, incremented on schema changes.
5. Add backup before migration (snapshot the DB before running `migrateLegacyConfig`).

---

## 8. Data Model Recommendations

### 8.1 Current Problems

1. **Flat key-value is opaque**: No way to know what keys exist, what types they are, or what's valid.
2. **JSON-in-TEXT is fragile**: Typos in device arrays break parsing silently.
3. **No schema enforcement**: A modbus device with a missing `transport` field just causes runtime crashes in the polling module.
4. **No migration tracking**: Can't tell if a database was migrated or needs migration.
5. **Giant dashboard_config blob**: Every dashboard save re-serializes the entire layout (10+ KB).

### 8.2 Recommended Schema for Settings

**Option A: Schema-Validated Key-Value (Minimal Change)**

Add a `config_schema` table:
```sql
CREATE TABLE config_schema (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,       -- 'string', 'integer', 'boolean', 'json'
  required INTEGER DEFAULT 0,
  default_value TEXT,
  description TEXT
);
```

Benefits: Validates on save. Self-documenting. Minimal migration effort.

**Option B: Dedicated Tables for Device Configs (Larger Change)**

```sql
CREATE TABLE ha_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  enabled INTEGER DEFAULT 1,
  poll_interval INTEGER DEFAULT 30,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE ha_device_entities (
  device_id INTEGER REFERENCES ha_devices(id),
  metric_name TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (device_id, metric_name)
);
```

Benefits: Referential integrity, typed columns, easier querying. But **much larger migration** and requires rewriting all polling modules.

**Recommendation:** Start with **Option A** (schema validation layer). Move to Option B only if device management complexity grows significantly.

### 8.3 Recommended Split for Dashboard Config

```
Current:
  dashboard_config (single JSON blob, ~10KB)

Proposed:
  dashboard_layouts    (JSON array of dashboards with block layouts)
  dashboard_active     (string, active dashboard ID)
  desktop_dashboard    (string, already separate)
  mobile_dashboard     (string, already separate)
  transparent_blocks   (boolean, already separate)
  dashboard_bg_color_light (string, already separate)
  dashboard_bg_color_dark  (string, already separate)
  dashboard_bg_image   (string, already separate)
  grid_status_entity   (string, already separate)
```

The `dashboard_layouts` key should store ONLY:
```json
[
  {
    "id": "main",
    "name": "Default",
    "layout": [ /* blocks */ ]
  }
]
```

Display settings and active dashboard should remain independent keys.

---

## 9. Summary of Impact by Redesign Scenario

| Redesign Decision | Backend Impact | Frontend Impact | Risk |
|------------------|---------------|-----------------|------|
| Keep current sections, reorder | None | Low (HTML reorder) | None |
| Split Data Sources into top-level | None (same keys) | Medium (HTML + nav logic) | Low |
| Replace sections with tabs | None | Medium | Low |
| Add wizard/multi-step flow | High (need partial save API) | High (form state management) | Medium |
| Split dashboard_config blob | Medium (new keys + migration) | High (editor refactor) | Medium |
| Add real-time validation per field | Low (add validation endpoint) | Medium (per-field API calls) | Low |
| Move from monolithic save to auto-save | High (need per-section save, conflict resolution) | High (dirty tracking per section) | High |
| Restructure into domain-driven sections | None if keys unchanged | Medium | Low |
| Add settings search | None | Low (client-side filter) | None |

---

## 10. Key Recommendations

1. **DO NOT change config key names** in the database. Reorganize the UI around the existing keys. This is the lowest-risk approach.

2. **Split the dashboard_config blob** as described in §8.3. This is the single biggest architectural improvement with the most long-term benefit.

3. **Fix the sensitive key filter regex** immediately (see §6.4) — this is a bug that silently drops data.

4. **Add per-section save endpoints** if wizard/multi-step navigation is planned. The monolithic save is the main blocker for that pattern.

5. **Implement schema validation** (Option A from §8.2) before adding new config keys — it will prevent future data corruption.

6. **Create a migration version tracker** (`config_version` key) to enable safe schema evolution across releases.

7. **Add DB transactions** to the save flow to prevent partial saves from corrupting state.

---

## Appendix A: All Config Keys in the System

| Key | Type | Where Used | Sensitive? |
|-----|------|-----------|------------|
| `ha_devices` | JSON array | server.js (save), ha.js (poll), settings.js (load/save) | Yes (contains tokens) |
| `mqtt_devices` | JSON array | server.js (save), mqtt.js (connect), settings.js (load/save) | Yes (contains passwords) |
| `modbus_devices` | JSON array | server.js (save), modbus.js (poll), settings.js (load/save) | No |
| `rs232_devices` | JSON array | server.js (save), rs232.js (poll), settings.js (load/save) | No |
| `external_sources` | JSON array | server.js (save), external.js (poll), settings.js (load/save) | No |
| `bms_devices` | JSON array | server.js (save), bms.js (poll), settings.js (load/save) | No |
| `bms_banks` | JSON array | server.js (save), bmsAggregator.js, settings.js | No |
| `dongle_config` | JSON array | server.js (save), dongle.js (poll), settings.js (load/save) | No |
| `pvoutput_config` | JSON object | server.js (save), pvoutput.js, settings.js | Yes (contains api_key) |
| `pvoutput_stats_cache` | JSON | pvoutput.js | No |
| `pvoutput_rate_limit_state` | JSON | pvoutput/rateLimiter.js | No |
| `dashboard_config` | JSON object | server.js, dashboard-config.js, dashboard.js, settings.js, editor.js | No |
| `dashboard_title` | string | public-config, branding | No |
| `dashboard_logo` | string | public-config, branding | No |
| `dashboard_favicon` | string | public-config, branding | No |
| `dashboard_bg_color` | string | public-config (legacy) | No |
| `dashboard_bg_color_light` | string | public-config, dashboard.js | No |
| `dashboard_bg_color_dark` | string | public-config, dashboard.js | No |
| `dashboard_bg_image` | string | public-config, dashboard.js | No |
| `transparent_blocks` | boolean string | public-config, dashboard.js | No |
| `desktop_dashboard` | string | public-config, dashboard.js | No |
| `mobile_dashboard` | string | public-config, dashboard.js | No |
| `savings_currency` | string | public-config, savings.js | No |
| `savings_rate` | string | public-config, savings.js | No |
| `savings_solar_metric` | string | savings.js | No |
| `all_time_pv_savings_override` | string | savings.js | No |
| `forecast_enabled` | boolean string | solar.js, settings.js | No |
| `solar_latitude` | string | solar.js, forecast | No |
| `solar_longitude` | string | solar.js, forecast | No |
| `solar_tilt` | string | solar.js, forecast | No |
| `solar_azimuth` | string | solar.js, forecast | No |
| `solar_capacity_kwp` | string | solar.js, forecast | No |
| `solcast_api_key` | string | solar.js | **Yes** (filtered by bug) |
| `solcast_resource_id` | string | solar.js | No |
| `solar_loss_factor` | string | solar.js, forecast | No |
| `solar_install_date` | string | solar.js, forecast | No |
| `role_metrics` | JSON object | server.js (role-metrics endpoint), history.js | No |
| `user_metrics` | JSON array | metricsManager.js (seed only) | No |
| `network_local_url` | string | network-detect.js | No |
| `network_remote_url` | string | network-detect.js | No |
| `external_poll_interval` | string | server.js (save), external.js | No |
| `rs232_poll_interval` | string | settings.js (form field only) | No |
| `grid_status_entity` | string | grid.js | No |

---

## Appendix B: Post-Save Service Restart Matrix

| Key(s) in Payload | Service Restarted | Module |
|-------------------|-------------------|--------|
| `mqtt_devices` | MQTT connections | `restartMqtt()` in mqtt.js |
| `external_sources` or `external_poll_interval` | External REST polling | `restartExternalPolling()` in external.js |
| `bms_devices` | BMS bridge polling | `restartBmsPolling()` in bms.js |
| `bms_banks` | BMS bridge polling + bank metric cleanup/creation | `restartBmsPolling()` + `cleanupOrphanedBankMetrics()` |
| `dongle_config` | Dongle polling | `restartDonglePolling()` in dongle.js |
| `pvoutput_config` | PVOutput push/pull engines | `pvoutput.restart()` |
| `rs232_devices` | RS232 streaming | `restartRs232Streaming()` in rs232.js |
| forecast keys (`forecast_enabled`, `solar_*`, `solcast_*`) | (currently none — cache reset commented out) | solar.js |
