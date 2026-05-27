# Development Guide – Epilykos

This guide explains how to extend Epilykos with new visual blocks, data sources, and metrics. Intended for developers comfortable with **JavaScript**, **Node.js**, **SQLite**, and basic **CSS/HTML**.

---

## Prerequisites

- Node.js 18+
- Epilykos installed (Docker or local)
- JavaScript ES6+ (ES modules)
- Async/await patterns
- Basic SQL

---

## Architecture Overview

### Backend (`modules/`)

| Module | Responsibility |
|--------|----------------|
| `database.js` | SQLite connection, `getConfig()`, `setConfig()` |
| `sessionAuth.js` | Session-based auth, CSRF, rate limiting |
| `ha.js` | Home Assistant polling |
| `mqtt.js` | MQTT broker connections |
| `modbus.js` | Modbus TCP/Serial |
| `dongle.js` | Inverter dongle polling loop, metric mapping, bulk register reads |
| `dongle/crc.js` | Modbus CRC-16, frame builder/parser |
| `dongle/solarmanV5.js` | Solarman V5 TCP client (proprietary framing) |
| `dongle/modbusTcp.js` | Plain Modbus TCP client (MBAP header) |
| `dongle/growatt.js` | Growatt TCP server (push-based, v1.24 + v3.05) |
| `external.js` | REST API polling |
| `bms.js` | Bluetooth BMS bridge |
| `history.js` | Legacy history snapshots |
| `grid.js` | Grid status tracking from any metric source (not just HA) |
| `solar.js` | Solar forecast (Solcast/Open-Meteo) |
| `savings.js` | PV savings |
| `metrics.js` | Current metrics, history |
| `metricsManager.js` | User-created metrics CRUD |
| `dashboard-config.js` | Layout config (JSON) |
| `backup.js` | Database backup/restore |
| `logger.js` | Winston logging |
| `utils.js` | Grid state parser |

### Frontend (`public/js/`)

All ES modules via `<script type="module">`.

| Module | Purpose |
|--------|---------|
| `main.js` | Entry — theme, config, WebSocket, polling |
| `dashboard.js` | CSS Grid + SortableJS, per-block config |
| `editor.js` | GridStack visual layout editor (`/editor`) |
| `updater.js` | Dispatches `updateWithState(state)` to blocks |
| `components/index.js` | `componentBuilders` registry (20 blocks) |
| `components/*.js` | Block builders + updaters |
| `api.js` | Centralised fetch |
| `charts.js` | Chart.js with multi-instance Maps |
| `forecast.js` | Multi-instance sparkline + weather |
| `tables.js` | Multi-instance data tables |
| `grid.js` | Grid card helpers |
| `utils/blockId.js` | Block ID generation |
| `utils/uid.js` | Scoped DOM ID helper |

### Data Flow

```
Polling (30s) → buildDashboardState() → WebSocket broadcast
    → Frontend updateWithState(state)
    → Each block updater reads state.metrics
Fallback: polling /api/dashboard-state every 60s
```

### Dashboard Layout

- **Absolute positioning** — blocks placed at exact pixel coordinates matching the editor. `left`/`width` use percentages (responsive), `top`/`minHeight` use pixels (50px row height).
- **GridStack coordinates** — each block stores `gridX`, `gridY`, `gridW`, `gridH` (12-column, 50px rows)
- `bgColor` — per-block background colour picker
- `transparent` — per-block transparency toggle
- **SortableJS** drag-to-reorder (auth-only, lock/unlock toggle)
- **Desktop/mobile defaults** — auto-switch dashboard tab by screen width
- **Multi-instance** — all blocks support duplicates via `uid(base, blockId)` scoped IDs

### Editor (`/editor`)

- GridStack visual layout designer (50px cell height, 12 columns)
- Palette: click to add, drag to reposition, drag edges to resize
- Click ✕ to remove, + New / Delete / Rename dashboards
- Saves raw GridStack coordinates (`gridX/Y/W/H`) — dashboard mirrors them exactly
- Save & Exit persists layout immediately

---

## Adding a New Block Type

### Step 1: Create the Builder

Create `public/js/components/myBlock.js`:

```javascript
import { uid } from '../utils/uid.js';

export function buildMyBlock(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || {};
  const myMetric = metrics.value || 'default_metric';

  const container = document.createElement('div');
  container.className = 'my-block card';
  container.dataset.metricMap = JSON.stringify({ value: myMetric });
  container.dataset.blockId = id;

  container.innerHTML = `
    <h3>${escapeHtml(config.title || 'My Block')}</h3>
    <div class="my-value" data-metric="${escapeHtml(myMetric)}">--</div>
  `;
  return container;
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
```

**Pattern**: Use `uid(base, id)` for all DOM IDs. Store metric config on `dataset.metricMap`. Use `data-metric` attributes. Provide defaults for backward compat.

### Step 2: Create the Updater

```javascript
export function updateMyBlock(state) {
  document.querySelectorAll('.my-block').forEach(container => {
    const id = container.dataset.blockId || '';
    let mm; try { mm = JSON.parse(container.dataset.metricMap); } catch(e) { return; }
    const m = state.metrics || {};
    const val = m[mm.value]?.value;
    if (val === undefined || val === null) return;
    const el = container.querySelector('.my-value');
    if (el) el.textContent = val.toFixed(1);
  });
}
```

**Pattern**: Iterate ALL containers of your type. Scope queries within each. Check for undefined/null values.

### Step 3: Register

Edit `components/index.js`:

```javascript
import { buildMyBlock, updateMyBlock } from './myBlock.js';
// Add to componentBuilders:
'my-block': buildMyBlock,
```

### Step 4: Register Updater

Edit `updater.js`:

```javascript
import { updateMyBlock } from './components/myBlock.js';
// Add to updateWithState:
if (activeLayout.some(b => b.type === 'my-block')) updateMyBlock(state);
```

### Step 5: Register in Settings

Edit `settings.js`. Add to the type dropdown:

```html
<option value="my-block">My Block</option>
```

Add config panel (in the config button handler):

```javascript
} else if (block.type === 'my-block') {
  const currentMetrics = block.config?.metrics || {};
  configPanel.innerHTML = `
    <label>Title</label><input type="text" class="config-title" value="${escapeHtml(block.config?.title||'')}" style="width:100%;margin-bottom:0.5rem;">
    <label>Value Metric</label><select class="config-metric" data-role="value" style="width:100%;margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.value)}</select>
    <button class="fetch-btn save-config">Save</button>`;
}
```

Add save handler:

```javascript
} else if (block.type === 'my-block') {
  block.config.title = configPanel.querySelector('.config-title')?.value || '';
  block.config.metrics = {};
  configPanel.querySelectorAll('.config-metric').forEach(s => { const r = s.dataset.role; if (s.value) block.config.metrics[r] = s.value; });
}
```

### Step 6: Add CSS

Add to `style.css`:

```css
.my-value { font-size: var(--fs-large); font-weight: 600; color: var(--text); }
```

### Step 7: Add to Editor Palette

The editor (`editor.js`) auto-discovers all builders from `componentBuilders`. Add a display name:

```javascript
const names = { 'my-block': 'My Block', ... };
```

---

## Key Patterns

### uid() Scoping

```javascript
import { uid } from '../utils/uid.js';
const id = block.id || '';
// In HTML: id="${uid('my-element', id)}"
// In updater: document.getElementById(uid('my-element', id))
```

### Metric Configurability

```javascript
// Builder: store on container
container.dataset.metricMap = JSON.stringify(metrics);

// Updater: read from container
let mm; try { mm = JSON.parse(container.dataset.metricMap); } catch(e) { return; }
const val = state.metrics?.[mm.some_role]?.value;
```

### Multi-Instance Updaters

```javascript
export function updateMyBlock(state) {
  document.querySelectorAll('.my-block').forEach(container => {
    // scope all queries within container
    const id = container.dataset.blockId || '';
    // ...
  });
}
```

### Per-Block Config

Each block in the dashboard editor has:
- Type dropdown, Width dropdown, Height dropdown
- Background colour picker (`block.bgColor`)
- Transparency checkbox (`block.transparent`)
- Config button for per-block settings (metrics, title, etc.)

---

## Adding a New Data Source

Create `modules/mySource.js` following the pattern in `external.js` (for poll-based sources) or `dongle.js` (for multi-transport sources with profiles). Register in `server.js`. Add the config key to `database.js` essentials. Add settings UI in `settings.html` and `settings.js`.

### Dongle Module Pattern

The dongle module (`modules/dongle.js`) demonstrates a multi-transport data source:

- **Transport layer** (`dongle/*.js`) — each transport exposes a single `readRegisters(startAddr, count)` method returning `Promise<Buffer>`.
- **Profile layer** (`profiles/dongles/*.json`) — each profile defines a register map with addresses, types, scales, and output metric names.
- **Orchestration layer** (`dongle.js`) — `startDonglePolling()` reads config, instantiates transports per instance, runs `pollInstance()` on an interval.
- **Bulk reading** — `buildPollRanges()` groups contiguous register addresses into ranges (allowing up to 4-register gaps) to minimise TCP round-trips.
- **Error handling** — consecutive failures trigger exponential back-off (doubles interval after 5 fails, max 5 min, resets on success).
- **Settings integration** — `GET /api/dongle/profiles` lists available profiles; `POST /api/dongle/test` tests a connection; restart on config save.

---
## Debug Logging

### Log Levels

Set in `.env`:
```bash
LOG_LEVEL=debug   # trace, debug, info, warn, error
```

Default is `info`. Set to `debug` to see per-poll metrics and timing.

### Log Files

`logs/energy-dashboard-YYYY-MM-DD.log` — JSON structured, rotates daily, keeps 14 days.

### Filtering Logs

```bash
# All dongle activity
grep '\[dongle\]' logs/energy-dashboard-*.log

# All warnings and errors
grep -E '\[warn\]|\[error\]' logs/energy-dashboard-*.log

# Specific instance
grep '\[dongle\] SRNE' logs/energy-dashboard-*.log

# Polling cycle timing
grep 'Polling cycle completed' logs/energy-dashboard-*.log
```

### Real-Time Monitoring

**Docker:**
```bash
docker compose logs -f epilykos
```

**Local:**
```bash
LOG_LEVEL=debug node server.js 2>&1 | tee debug.log
```

### Common Log Patterns

| Log Line | Meaning |
|----------|---------|
| `[dongle] InstanceName: N metrics in Xms` | Successful poll — N metrics written |
| `[dongle] InstanceName: poll failed — timeout` | Dongle didn't respond within timeout |
| `[dongle] InstanceName: poll failed — checksum mismatch` | Corrupted frame — usually transient |
| `[dongle] profile X not found for Y` | Profile JSON missing from `profiles/dongles/` |
| `[dongle:growatt] connection from IP:port` | Growatt dongle connected and pushing data |
| `Polling cycle completed in Xms` | Full 30s cycle done — all sources polled |

---
## Troubleshooting Development Issues

| Problem | Check |
|---------|-------|
| New route returns 404 | Server needs restart — it only loads routes at boot |
| `Cannot GET /api/...` | Route not registered or server running old code |
| Module import fails | Check `require()` path — relative from module's directory |
| `getDb()` throws "not initialized" | Calling DB before `initializeDatabase()` completes |
| Metrics not appearing | Verify metric name matches exactly (case-sensitive). Check prefix. |
| Transport hangs | Timeout is 8s (V5), 5s (Modbus TCP). Check socket is destroyed on error. |
| Settings not persisting | Array config keys must bypass the form name-collection in save handler — use `collectDeviceArray()` |

---

## Coding Conventions

- Use `const` for immutable values
- `escapeHtml()` for user input in innerHTML
- `data-*` attributes for metadata
- `JSON.stringify/parse` for storing objects in data attributes
- Check for `undefined`/`null` before displaying values
- Polling functions never throw — log and continue
- Chart.js instances stored in Maps keyed by canvas ID

---

## Complete Example

See `gaugeCard.js` (full-circle SVG gauge), `multiValueCard.js` (unlimited metrics), `textCard.js` (static HTML content), `iframeCard.js` (URL embed), or `flowCardSquare.js` (2×2 grid layout) for complete examples of different block patterns.
