# RS232 Inverter Data Source — Technical Implementation Plan

> Implementation plan for adding raw RS232 serial inverter support to Epilykos
> (Node.js/Express/SQLite v2.7.0). Follows existing data source patterns for
> Modbus, MQTT, External REST, and BMS bridge.
>
> Target: Epilykos dev branch at `/home/ashipa/epilykos-dev/`

---

## Phase 0: Pre-Flight — Verify Dependencies

### 0.1 Check serialport Availability

The `serialport` npm package (v8.0.8) is already installed as a transitive
dependency of `modbus-serial`. It can be used directly without adding it to
`package.json` explicitly, but it should be added as a direct dependency for
documentation and lockfile clarity:

```bash
npm install serialport@^8.0.0 --save
```

### 0.2 Chokidar (Optional — Hotplug)

For hotplug port detection (Phase 3), add chokidar:

```bash
npm install chokidar --save
```

### 0.3 Node.js Compatibility

`serialport` v8.x requires:
- Node.js ≥ 10 (Epilykos is on 18+ — compatible)
- Native build tools (prebuild binaries available for common platforms)
- Linux: `libudev-dev` for USB detection (usually pre-installed)

---

## Phase 1: Backend Module — `modules/rs232.js`

### 1.1 File Structure

Create `/home/ashipa/epilykos-dev/modules/rs232.js` following the exact
pattern of `modules/modbus.js`:

```
modules/rs232.js            # Core RS232 module
modules/rs232-decoders/     # Optional JS decoder modules for binary protocols
  solax-decoder.js          # SolaX AA55 binary frame parser
  rs232-utils.js            # Helper utilities (CRC, byte utils, XOR checksum, port utils)
profiles/rs232/             # RS232/RS485 protocol profiles (JSON)
  voltronic.json            # Voltronic/Axpert QPIGS (also Phocos, MUST, Sako, Infinisolar)
  vedirect.json             # Victron VE.Direct (streaming)
  solax-pocket-usb.json     # SolaX Pocket USB (AA55 binary, with decoder)

# Brands covered by existing Modbus module (RS485 serial transport):
#   Solis — Modbus RTU over RS485, well-documented register maps
#   Luxpower — Modbus RTU over RS485 (RS485 path); custom TCP dongle → future dongle module
#
# Not suitable for RS232 module:
#   Alpsolar — cloud-only (Inteless API), no local serial
#   Lvtopsun — battery manufacturer, not inverters
#   Haisic — no public protocol documentation available
#   SMK — no public protocol documentation available
```

### 1.2 Module Interface

```javascript
// modules/rs232.js

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { DelimiterParser } = require('@serialport/parser-delimiter');
const fs = require('fs');
const path = require('path');
const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');

// Exported functions (matching Modbus module pattern):
module.exports = {
  loadProfiles,               // Load RS232 profiles from /profiles/rs232/
  pollRs232,                  // Main poll function called from pollAllSources()
  testRs232Connection,        // Test button handler
  getAvailablePorts,          // List serial ports for settings UI
  shutdownRs232,              // Graceful close of all streaming connections (call on SIGTERM/SIGINT)
  availableProfiles,          // { id, name, protocol }[]
};

// ── Process Exit Cleanup ────────────────────────────────────
// Prevents lingering port locks on /dev/ttyUSB0 after crash/restart.
// Called from server.js process.on('SIGTERM') and process.on('SIGINT').
async function shutdownRs232() {
  logger.info('RS232 shutdown: closing all streaming connections');
  for (const [name, conn] of streamingConnections) {
    try { conn.port.close(); } catch (e) { /* ignore */ }
  }
  streamingConnections.clear();
  logger.info('RS232 shutdown complete');
}
```

### 1.3 Poll Orchestration Logic

```javascript
async function pollRs232() {
  const devices = JSON.parse(getConfig('rs232_devices') || '[]');
  if (!devices.length) return;

  for (const device of devices) {
    if (!device.enabled) continue;
    
    // Apply throttling based on consecutive failures
    const failCount = failCounts.get(device.name) || 0;
    if (failCount >= 5) {
      // Skip every other poll at 5+ failures
      if ((pollCycleCounter % 2) === 0) continue;
    }
    if (failCount >= 10) continue; // Stop trying

    try {
      const profile = availableProfiles.find(p => p.id === device.profile);
      if (!profile) {
        logger.error(`RS232 profile '${device.profile}' not found`);
        continue;
      }

      if (profile.protocol === 'vedirect-streaming') {
        // Streaming protocol — uses long-lived connection
        await pollStreamingDevice(device, profile);
      } else {
        // Poll-based protocol — open, query, parse, close
        await pollQueryDevice(device, profile);
      }

      // Success — reset fail counter
      failCounts.set(device.name, 0);
    } catch (err) {
      handlePollError(device, err);
    }
  }
}
```

### 1.4 Serial Port Open/Close (for poll-based protocols)

```javascript
async function openSerialPort(device) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path: device.serial_path || '/dev/ttyUSB0',
      baudRate: parseInt(device.baud) || 9600,
      dataBits: parseInt(device.data_bits) || 8,
      stopBits: parseInt(device.stop_bits) || 1,
      parity: device.parity || 'none',
      autoOpen: false,
    });

    port.open(err => {
      if (err) {
        // Enhanced error messages for common issues
        if (err.message.includes('EACCES')) {
          reject(new Error(`Permission denied on ${device.serial_path}. Ensure user is in 'dialout' group.`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`Port ${device.serial_path} not found. Check connection.`));
        } else {
          reject(err);
        }
      } else {
        resolve(port);
      }
    });
  });
}

async function closeSerialPort(port) {
  return new Promise(resolve => {
    if (!port || !port.isOpen) return resolve();
    port.close(() => resolve());
  });
}
```

### 1.5 Query/Response Cycle (for poll-based protocols)

```javascript
async function queryDevice(port, query, profile, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let timer = setTimeout(() => {
      port.removeAllListeners('data');
      if (buffer.length > 0) {
        // Return whatever we have on timeout — the decoder may still parse it
        resolve(buffer);
      } else {
        reject(new Error('RS232 read timeout'));
      }
    }, timeoutMs);

    port.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      // Frame detection: the profile provides isCompleteFrame(buffer) callback
      const detectFn = profile.isCompleteFrame || defaultFrameDetect;
      if (detectFn(buffer, profile)) {
        clearTimeout(timer);
        port.removeAllListeners('data');
        resolve(buffer);
      } else {
        // Not enough data yet — timer continues running
        timer.refresh();
      }
    });

    port.write(query, err => {
      if (err) {
        clearTimeout(timer);
        port.removeAllListeners('data');
        reject(err);
      }
    });
  });
}

// Default frame detection: look for CRC + CR terminator (Voltronic-style ASCII)
function defaultFrameDetect(buffer, profile) {
  if (buffer.length < 4) return false;
  // Voltronic: response ends with CRC chars + \r
  if (profile.protocol === 'voltronic' || profile.protocol === 'voltronic-ascii') {
    const text = buffer.toString('utf8');
    return text.endsWith('\r');
  }
  // Binary: frame length declared in header byte
  return false;
}

async function pollQueryDevice(device, profile) {
  const port = await openSerialPort(device);
  try {
    const results = {};

    for (const cmd of profile.commands) {
      const queryBuffer = encodeQuery(cmd, device, profile);
      const rawResponse = await queryDevice(port, queryBuffer, parseInt(device.timeout) || 5000);
      const parsed = decodeResponse(rawResponse, cmd, profile, device);
      Object.assign(results, parsed);
    }

    // Write to database
    const now = Math.floor(Date.now() / 1000);
    for (const [metric, value] of Object.entries(results)) {
      getMetricInsert().run(now, metric, value);
      getLatestUpsert().run(metric, value, now);
    }
    logger.info(`RS232 poll ${device.name}: ${Object.keys(results).length} metrics`);
  } finally {
    await closeSerialPort(port);
  }
}
```

### 1.6 Streaming Protocol Handling (Victron VE.Direct)

Victron inverters continuously push data over serial. A long-lived connection
is needed with a frame detector.

```javascript
const streamingConnections = new Map(); // device_name → { port, buffer, parser }

function setupStreamingConnection(device, profile) {
  // Tear down existing if any
  teardownStreamingConnection(device.name);

  const port = new SerialPort({
    path: device.serial_path,
    baudRate: parseInt(device.baud) || 19200,
    dataBits: 8, stopBits: 1, parity: 'none',
  });

  // Use ReadlineParser for line-oriented protocols (VE.Direct uses \n)
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  
  let currentFrame = {};

  parser.on('data', line => {
    line = line.trim();
    if (!line) return;

    // Parse key-value pair
    const [key, ...valParts] = line.split('\t');
    const value = valParts.join('\t');

    if (key === 'Checksum') {
      // Frame complete — process metrics
      const metrics = decodeVedirectFrame(currentFrame, profile);
      if (Object.keys(metrics).length > 0) {
        const now = Math.floor(Date.now() / 1000);
        for (const [metric, val] of Object.entries(metrics)) {
          getMetricInsert().run(now, metric, val);
          getLatestUpsert().run(metric, val, now);
        }
      }
      currentFrame = {}; // Reset for next frame
    } else {
      currentFrame[key] = value;
    }
  });

  port.on('error', err => {
    logger.error(`RS232 streaming ${device.name} error: ${err.message}`);
    // Schedule reconnect
    setTimeout(() => setupStreamingConnection(device, profile), 10000);
  });

  streamingConnections.set(device.name, { port, parser, device, profile });
}

function teardownStreamingConnection(name) {
  const conn = streamingConnections.get(name);
  if (conn) {
    try { conn.port.close(); } catch(e) {}
    streamingConnections.delete(name);
  }
}

function pollStreamingDevice(device, profile) {
  // For streaming devices, the connection persists.
  // This function just checks that the connection is alive.
  // Metrics are written in real-time by the parser's 'data' handler.
  const conn = streamingConnections.get(device.name);
  if (!conn || !conn.port.isOpen) {
    setupStreamingConnection(device, profile);
  }
}
```

### 1.7 Decoder Implementations

**Generic ASCII field-index decoder** (for Voltronic, Growatt simple, Fronius):

```javascript
function decodeAsciiResponse(buffer, cmd, profile) {
  const text = buffer.toString('utf8').trim();
  const prefix = cmd.response.prefix || '';
  
  let dataStr = text;
  if (prefix && text.startsWith(prefix)) {
    dataStr = text.slice(prefix.length);
  }
  
  // Determine delimiter
  const delimiter = cmd.response.delimiter || '\t';
  const fields = dataStr.split(delimiter);
  
  const results = {};
  for (const fieldDef of cmd.fields) {
    const idx = fieldDef.index;
    if (idx >= fields.length || idx < 0) continue;
    
    let raw = parseFloat(fields[idx].trim());
    if (isNaN(raw)) continue;
    
    if (fieldDef.scale) raw *= fieldDef.scale;
    const metricName = fieldDef.metric;
    results[metricName] = raw;
  }
  
  return results;
}
```

**Voltronic-specific decoder:**

The QPIGS response format is:
```
(000.0 230.1 50.00 000.0 00.00 000.0 00.0 000.0 025.1 0013 0000 0.00 00000 00000 00000 00000 00 00 00 00.0\r\n
```
Fields are separated by space, prefixed by `(`. The profile JSON lists field indices.

**VE.Direct frame decoder:**

```javascript
function decodeVedirectFrame(frame, profile) {
  const results = {};
  for (const fieldDef of profile.fields) {
    const raw = frame[fieldDef.label];
    if (raw === undefined) continue;
    
    let val = parseFloat(raw);
    if (isNaN(val)) continue;
    if (fieldDef.scale) val *= fieldDef.scale;
    if (fieldDef.type === 'millivolt') val = val * 0.001; // mV → V
    if (fieldDef.type === 'milliamp') val = val * 0.001; // mA → A
    
    const metricName = fieldDef.metric_prefix
      ? `${fieldDef.metric_prefix}_${fieldDef.metric}`
      : fieldDef.metric;
    results[metricName] = parseFloat(val.toFixed(3));
  }
  return results;
}
```

### 1.8 Test Connection Handler

```javascript
async function testRs232Connection(device) {
  const profile = availableProfiles.find(p => p.id === device.profile);
  if (!profile) throw new Error(`Profile '${device.profile}' not found`);
  if (profile.protocol === 'vedirect-streaming') {
    // For streaming, just verify the port opens
    const port = await openSerialPort(device);
    await new Promise(r => setTimeout(r, 2000)); // wait for data
    await closeSerialPort(port);
    return { success: true, message: 'Port opened successfully' };
  }
  // For poll-based, execute first command
  const port = await openSerialPort(device);
  try {
    const cmd = profile.commands[0];
    const query = encodeQuery(cmd, device, profile);
    const raw = await queryDevice(port, query, 5000);
    const parsed = decodeResponse(raw, cmd, profile, device);
    return { success: true, metrics: parsed };
  } finally {
    await closeSerialPort(port);
  }
}
```

### 1.9 Port Listing (for UI)

```javascript
async function getAvailablePorts() {
  const ports = await SerialPort.list();
  return ports.map(p => ({
    path: p.path,
    manufacturer: p.manufacturer || 'Unknown',
    vendorId: p.vendorId || '',
    productId: p.productId || '',
    friendlyName: `[${p.path}] ${p.manufacturer || 'Unknown adapter'}`,
  }));
}
```

---

## Phase 2: Server Integration — `server.js`

### 2.1 Import Module

In `server.js` (near line 42, where other modules are imported):

```javascript
const { loadProfiles, pollRs232, testRs232Connection, getAvailablePorts, availableProfiles }
  = require('./modules/rs232');
```

### 2.2 Declare essential config key

In `database.js` line 154-161, add `'rs232_devices'` to the `essentialKeys` array:

```javascript
const essentialKeys = [
  'ha_devices', 'mqtt_devices', 'modbus_devices', 'rs232_devices', // ← ADD
  'dashboard_config', 'solar_latitude', ...
];
```

### 2.3 Initialize Profiles

In `server.js` near line 67 where `loadProfiles()` is called for Modbus:

```javascript
loadProfiles();                  // Modbus profiles
loadRs232Profiles();             // NEW: RS232 profiles
```

### 2.4 Add to Poll Loop

In `pollAllSources()` (line 226-244):

```javascript
async function pollAllSources() {
  const start = Date.now();
  logger.debug('Polling cycle started');
  try {
    await pollHomeAssistant();
    await pollModbus();
    await pollRs232();           // ← NEW: between Modbus and history
    await pollLegacyHistory();
    await pollGridStatus();
    const state = await buildDashboardState();
    broadcastDashboardState(state);
    const elapsed = Date.now() - start;
    logger.info(`Polling cycle completed in ${elapsed}ms`);
  } catch (err) {
    logger.error('Polling error:', err);
  }
}
```

**Important:** The order matters — `pollRs232()` runs after `pollModbus()` to
avoid compounding timeout delays if both use the same hardware resources.

### 2.5 Process Exit Cleanup

In `server.js`, add before the main polling loop (near line 220):

```javascript
// Graceful RS232 shutdown — close streaming ports on exit
process.on('SIGTERM', async () => {
  await shutdownRs232();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await shutdownRs232();
  process.exit(0);
});
```

This prevents lingering port locks on `/dev/ttyUSB0` after crash/restart.
Without this, the OS holds the port open for 30-60s on some USB serial adapters,
blocking re-open on the next start.

### 2.6 API Endpoints

Add near line 620-638 (after Modbus API endpoints):

```javascript
// ── RS232 Data Source ──────────────────────────────────────────────────────
app.use('/api/rs232/profiles', isAuthenticated);
app.get('/api/rs232/profiles', (req, res) => {
  res.json(availableRs232Profiles.map(p => ({ id: p.id, name: p.name, protocol: p.protocol })));
});

app.use('/api/rs232/ports', isAuthenticated);
app.get('/api/rs232/ports', async (req, res) => {
  try {
    const ports = await getAvailablePorts();
    res.json(ports);
  } catch (err) {
    logger.error('RS232 port scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/test-rs232', isAuthenticated);
app.post('/api/test-rs232', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (!device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  if (!device.profile) return res.status(400).json({ error: 'Profile required' });
  try {
    const result = await testRs232Connection(device);
    res.json(result);
  } catch (err) {
    logger.error('RS232 test error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

### 2.7 Settings Save Handler

In `app.post('/api/settings', ...)` (line 715-741), add after the MQTT/dongle
restart checks:

```javascript
if ('rs232_devices' in updates) {
  // Restart streaming connections if any
  restartRs232Streaming();
}
```

If we add a global RS232 poll interval setting:
```javascript
if ('rs232_poll_interval' in updates) {
  // No action needed — the main poll loop interval handles this
}
```

---

## Phase 3: Frontend — Settings UI

### 3.1 HTML Template — `public/settings.html`

Add a new subtab for RS232 devices (near line 304, after the Modbus subtab):

```html
<div id="subtab-rs232" class="sub-tab-content">
  <div id="rs232-devices-container"></div>
  <button type="button" id="add-rs232-device" class="fetch-btn">+ Add RS232 Device</button>
  <div class="stg-form-row" style="margin-top:1rem;">
    <div class="stg-form-group">
      <label for="rs232-poll-interval">Global Poll Interval (seconds)</label>
      <input class="stg-input" id="rs232-poll-interval" name="rs232_poll_interval" value="30">
    </div>
  </div>
  <div class="note">RS232 devices require a USB-to-serial adapter. Available ports are auto-detected.</div>
</div>
```

And add `rs232` to the subtab navigation buttons (near line 290):

```html
<button class="stg-subnav-btn" data-subtab="rs232">RS232</button>
```

### 3.2 JavaScript — `public/settings.js`

**Add RS232 rendering functions:**

```javascript
// ── RS232 Devices ──────────────────────────────────────────────────────────
let rs232DeviceCounter = 0;
let availableRs232Ports = [];

function buildRs232DeviceList(devices) {
  const container = document.getElementById('rs232-devices-container');
  container.innerHTML = '';
  rs232DeviceCounter = 0;
  // Fetch available serial ports
  fetch('/api/rs232/ports').then(r => r.json()).then(ports => {
    availableRs232Ports = ports;
    devices.forEach((dev, idx) => renderRs232Device(dev, idx));
  }).catch(() => {
    availableRs232Ports = [];
    devices.forEach((dev, idx) => renderRs232Device(dev, idx));
  });
}

function renderRs232Device(device, idx) {
  const container = document.getElementById('rs232-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="rs232_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <label><input type="checkbox" name="rs232_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn danger" data-action="remove-rs232">Remove</button>
    </div>
    <div class="stg-section-divider"><span class="stg-divider-icon">🔌</span> Connection</div>
    <div class="form-row">
      <select name="rs232_devices[${idx}][serial_path]" class="rs232-port-select">
        <option value="">-- Select serial port --</option>
        ${availableRs232Ports.map(p =>
          `<option value="${escapeHtml(p.path)}" ${p.path === device.serial_path ? 'selected' : ''}>${escapeHtml(p.friendlyName)}</option>`
        ).join('')}
        <option value="custom">Custom path...</option>
      </select>
    </div>
    <div class="form-row rs232-custom-path" style="${device.serial_path && !availableRs232Ports.find(p => p.path === device.serial_path) ? '' : 'display:none;'}">
      <input type="text" name="rs232_devices[${idx}][custom_path]" placeholder="/dev/ttyUSB0" value="${escapeHtml(device.serial_path || '/dev/ttyUSB0')}">
    </div>
    <div class="form-row">
      <select name="rs232_devices[${idx}][baud]">
        ${[300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b =>
          `<option value="${b}" ${(device.baud || 9600) == b ? 'selected' : ''}>${b} baud</option>`
        ).join('')}
      </select>
      <select name="rs232_devices[${idx}][parity]">
        <option value="none" ${(device.parity || 'none') === 'none' ? 'selected' : ''}>None</option>
        <option value="even" ${device.parity === 'even' ? 'selected' : ''}>Even</option>
        <option value="odd" ${device.parity === 'odd' ? 'selected' : ''}>Odd</option>
      </select>
      <select name="rs232_devices[${idx}][data_bits]">
        <option value="7" ${(device.data_bits || 8) == 7 ? 'selected' : ''}>7 bits</option>
        <option value="8" ${(device.data_bits || 8) == 8 ? 'selected' : ''}>8 bits</option>
      </select>
      <select name="rs232_devices[${idx}][stop_bits]">
        <option value="1" ${(device.stop_bits || 1) == 1 ? 'selected' : ''}>1 stop</option>
        <option value="2" ${(device.stop_bits || 1) == 2 ? 'selected' : ''}>2 stop</option>
      </select>
    </div>
    <div class="stg-section-divider"><span class="stg-divider-icon">⚙️</span> Configuration</div>
    <div class="form-row">
      <select name="rs232_devices[${idx}][profile]" class="rs232-profile-select">
        <option value="">-- Select profile --</option>
      </select>
      <input type="number" name="rs232_devices[${idx}][timeout]" placeholder="Timeout (ms)" value="${device.timeout || 5000}" style="width:140px;">
      <button type="button" class="fetch-btn test-rs232">Test RS232</button>
    </div>
    <div id="rs232-device-metrics-${idx}" class="stg-section-divider" style="display:${device.profile ? '' : 'none'}">
      <span class="stg-divider-icon">📊</span> Profile Metrics
    </div>
  `;
  container.appendChild(card);

  // Port select toggle
  const portSelect = card.querySelector('.rs232-port-select');
  const customPathDiv = card.querySelector('.rs232-custom-path');
  portSelect.addEventListener('change', e => {
    customPathDiv.style.display = e.target.value === 'custom' ? '' : 'none';
  });

  // Profile select
  const profileSelect = card.querySelector('.rs232-profile-select');
  fetch('/api/rs232/profiles').then(r => r.json()).then(profiles => {
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.protocol})`;
      if (p.id === device.profile) opt.selected = true;
      profileSelect.appendChild(opt);
    });
  });

  // Remove handler
  card.querySelector('[data-action="remove-rs232"]').addEventListener('click', () => {
    if (confirm('Remove this RS232 device?')) {
      card.remove();
      reindexRs232();
    }
  });

  // Test button
  card.querySelector('.test-rs232').addEventListener('click', async function() {
    const statusEl = document.createElement('span');
    statusEl.className = 'test-status';
    this.after(statusEl);
    const dev = collectRs232Config(card);
    try {
      const res = await fetch('/api/test-rs232', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dev),
      });
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `OK: ${Object.keys(data.metrics || {}).length} metrics`, 'success');
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  rs232DeviceCounter++;
}

function reindexRs232() {
  const cards = document.querySelectorAll('#rs232-devices-container .device-card');
  rs232DeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    rs232DeviceCounter++;
  });
}

// Add button handler
const addRs232Btn = document.getElementById('add-rs232-device');
if (addRs232Btn) addRs232Btn.addEventListener('click', () => {
  const idx = rs232DeviceCounter;
  renderRs232Device({
    name: '', serial_path: '', baud: 9600, data_bits: 8,
    stop_bits: 1, parity: 'none', profile: '', timeout: 5000,
    enabled: true,
  }, idx);
});

// Helper: collect RS232 device config from card
function collectRs232Config(card) {
  const dev = {};
  dev.name = card.querySelector('.device-header input[type="text"]').value;
  dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
  
  const portSelect = card.querySelector('.rs232-port-select');
  const customPath = card.querySelector('input[name$="[custom_path]"]')?.value;
  dev.serial_path = portSelect.value === 'custom' ? (customPath || '/dev/ttyUSB0') : portSelect.value;
  
  dev.baud = parseInt(card.querySelector('select[name$="[baud]"]').value) || 9600;
  dev.parity = card.querySelector('select[name$="[parity]"]').value || 'none';
  dev.data_bits = parseInt(card.querySelector('select[name$="[data_bits]"]').value) || 8;
  dev.stop_bits = parseInt(card.querySelector('select[name$="[stop_bits]"]').value) || 1;
  dev.profile = card.querySelector('.rs232-profile-select').value;
  dev.timeout = parseInt(card.querySelector('input[name$="[timeout]"]').value) || 5000;
  return dev;
}
```

### 3.3 Collect Form Data on Save

In `settings.js` `saveSettings` handler (near line 2008, after modbus_devices collection):

```javascript
payload.rs232_devices = collectDeviceArray('rs232-devices-container', (card) => {
  return collectRs232Config(card);
});
```

### 3.4 Load Settings

In `settings.js` `loadSettings()` function, add rs232_devices to the skip list
(near line 31) and call `buildRs232DeviceList` (near line 42):

```javascript
// In the skip-if block:
if (key.startsWith('ha_devices') || key.startsWith('mqtt_devices') || key.startsWith('modbus_devices') || key.startsWith('rs232_devices') || ...) continue;

// In the load section:
buildRs232DeviceList(JSON.parse(data.rs232_devices || '[]'));
```

---

## Phase 4: Initial Protocol Profiles

### 4.1 Voltronic/Axpert QPIGS Profile

`/home/ashipa/epilykos-dev/profiles/rs232/voltronic-qpigs.json`:

```json
{
  "name": "Voltronic / Axpert (QPIGS ASCII)",
  "protocol": "voltronic-qpigs",
  "transport": "rs232",
  "defaults": {
    "baud": 2400,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none"
  },
  "commands": [
    {
      "name": "QPIGS",
      "query": "QPIGS\r\n",
      "response": {
        "type": "ascii-line",
        "prefix": "(",
        "delimiter": " "
      },
      "fields": [
        {"index": 0,  "metric": "grid_voltage",     "scale": 1,     "unit": "V"},
        {"index": 1,  "metric": "grid_frequency",    "scale": 0.01,  "unit": "Hz", "type": "hz-raw"},
        {"index": 2,  "metric": "ac_output_voltage", "scale": 1,     "unit": "V"},
        {"index": 3,  "metric": "ac_output_frequency","scale": 0.01, "unit": "Hz"},
        {"index": 4,  "metric": "load_va",           "scale": 1,     "unit": "VA"},
        {"index": 5,  "metric": "load_power",        "scale": 1,     "unit": "W"},
        {"index": 6,  "metric": "battery_voltage",   "scale": 0.1,   "unit": "V"},
        {"index": 7,  "metric": "battery_charge_current","scale": 1, "unit": "A"},
        {"index": 8,  "metric": "battery_soc",       "scale": 1,     "unit": "%"},
        {"index": 9,  "metric": "inverter_temp",     "scale": 1,     "unit": "°C"},
        {"index": 10, "metric": "solar_current",     "scale": 1,     "unit": "A"},
        {"index": 11, "metric": "solar_voltage",     "scale": 0.1,   "unit": "V"},
        {"index": 12, "metric": "battery_scc_voltage","scale": 0.1,  "unit": "V"},
        {"index": 13, "metric": "battery_discharge_current","scale":1,"unit": "A"}
      ]
    },
    {
      "name": "QMOD",
      "query": "QMOD\r\n",
      "response": { "type": "ascii-char", "prefix": "(" },
      "fields": [
        {"index": 0, "metric": "inverter_mode", "scale": 1, "unit": "", "type": "mode-char"}
      ]
    }
  ]
}
```

### 4.2 Victron VE.Direct (Streaming) Profile

`/home/ashipa/epilykos-dev/profiles/rs232/vedirect.json`:

```json
{
  "name": "Victron VE.Direct",
  "protocol": "vedirect-streaming",
  "transport": "rs232",
  "defaults": {
    "baud": 19200,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none"
  },
  "fields": [
    {"label": "V",     "metric": "battery_voltage",   "scale": 0.001, "type": "millivolt", "unit": "V"},
    {"label": "I",     "metric": "battery_current",   "scale": 0.001, "type": "milliamp",  "unit": "A"},
    {"label": "VPV",   "metric": "solar_voltage",     "scale": 0.01,  "unit": "V"},
    {"label": "PPV",   "metric": "solar_power",       "scale": 1,     "unit": "W"},
    {"label": "SOC",   "metric": "battery_soc",       "scale": 0.1,   "unit": "%"},
    {"label": "T",     "metric": "battery_temp",      "scale": 0.1,   "unit": "°C"},
    {"label": "H1",    "metric": "daily_yield",       "scale": 0.01,  "unit": "kWh"},
    {"label": "H2",    "metric": "daily_yield_load",  "scale": 0.01,  "unit": "kWh"},
    {"label": "H5",    "metric": "total_yield",       "scale": 0.01,  "unit": "kWh"},
    {"label": "H6",    "metric": "total_yield_load",  "scale": 0.01,  "unit": "kWh"},
    {"label": "HSDS",  "metric": "day_sequence",      "scale": 1,     "unit": ""},
    {"label": "MPPT",  "metric": "mppt_mode",         "scale": 1,     "unit": "", "type": "mode"},
    {"label": "LOAD",  "metric": "load_state",        "scale": 1,     "unit": "", "type": "bool"},
    {"label": "CS",    "metric": "charge_state",      "scale": 1,     "unit": "", "type": "mode"}
  ]
}
```

### 4.4 SolaX Pocket USB Profile (with JS Decoder)

`/home/ashipa/epilykos-dev/profiles/rs232/solax-pocket-usb.json`:

```json
{
  "name": "SolaX Pocket USB (AA55 Binary)",
  "protocol": "solax-aa55",
  "transport": "rs232",
  "defaults": {
    "baud": 9600,
    "data_bits": 8,
    "stop_bits": 1,
    "parity": "none",
    "timeout": 5000
  },
  "commands": [
    { "name": "register_dongle", "function": 0x01, "control": 0x02, "payload": "EPILYKOS01" },
    { "name": "request_serial",  "function": 0x05, "control": 0x01 },
    { "name": "request_data",    "function": 0x0C, "control": 0x01 }
  ],
  "frame_format": {
    "header": "AA55",
    "checksum": "additive-16le",
    "min_length": 7,
    "max_length": 255,
    "is_complete": "frame[2] === total_length"
  },
  "call_order": ["register_dongle", "request_serial", "request_data"],
  "fields": [
    { "metric": "grid_voltage",     "offset": 0,  "type": "uint16", "scale": 0.1, "unit": "V" },
    { "metric": "grid_current",     "offset": 2,  "type": "uint16", "scale": 0.1, "unit": "A" },
    { "metric": "grid_power",       "offset": 4,  "type": "int16",  "scale": 1.0, "unit": "W" },
    { "metric": "pv1_power",        "offset": 6,  "type": "uint16", "scale": 1.0, "unit": "W" },
    { "metric": "pv2_power",        "offset": 8,  "type": "uint16", "scale": 1.0, "unit": "W" },
    { "metric": "battery_voltage",  "offset": 10, "type": "uint16", "scale": 0.1, "unit": "V" },
    { "metric": "battery_power",    "offset": 12, "type": "int16",  "scale": 1.0, "unit": "W" },
    { "metric": "battery_soc",      "offset": 14, "type": "uint16", "scale": 1.0, "unit": "%" },
    { "metric": "energy_today",     "offset": 16, "type": "uint16", "scale": 0.1, "unit": "kWh" },
    { "metric": "energy_total",     "offset": 18, "type": "uint32", "scale": 0.1, "unit": "kWh" },
    { "metric": "inverter_temp",    "offset": 22, "type": "int16",  "scale": 1.0, "unit": "°C" },
    { "metric": "grid_frequency",   "offset": 24, "type": "uint16", "scale": 0.01, "unit": "Hz" }
  ]
}
```

**SolaX communication sequence:**
1. Send `register_dongle` frame with 10-char arbitrary serial (e.g. "EPILYKOS01")
2. Inverter echoes the register frame (ignore)
3. Send `request_serial` — get back inverter serial + model code
4. Send `request_data` — get back live data payload
5. Payload offset/length depends on inverter family (X1 Grid-Tie vs X1 Hybrid vs X3)

**Decoder (modules/rs232-decoders/solax-decoder.js):**
The decoder handles:
- Frame assembly: `AA 55 [size][ctrl][func][payload][chk_lo][chk_hi]`
- Checksum verification: 16-bit additive LE over all preceding bytes
- Payload extraction using offset map from profile
- Family-specific payload layouts (different lengths for X1 vs X3 vs hybrid)
- Reference: github.com/jesserockz/aiosolax-uart (Python) for exact byte offsets

### 4.5 Infinisolar — Already Covered by Voltronic Profile

Infinisolar is a **confirmed Voltronic/Axpert rebadge**. The existing Voltronic QPIGS
profile (`profiles/rs232/voltronic.json`) fully supports Infinisolar inverters.

**No additional profile needed.** Add an alias entry so the settings UI shows
"Infinisolar" as a separate selectable option pointing to the same `voltronic-qpigs`
protocol:

```json
// Alias entry in availableProfiles, NOT a separate file:
{
  "id": "infinisolar",
  "name": "Infinisolar (Voltronic QPIGS)",
  "protocol": "voltronic-qpigs",
  "profile_file": "voltronic.json"
}
```

### 4.6 Solis — Covered by Existing Modbus Module (RS485)

Solis inverters use **standard Modbus RTU over RS485** — the Epilykos Modbus module
already handles this. Use the existing Modbus data source with RS485 serial transport.

**Solis Modbus registers** (well-documented at [solis-modbus.readthedocs.io](https://solis-modbus.readthedocs.io/en/latest/sensors.html)):
- String inverters: registers 2xxx (basic), 3xxx (AC/DC readings), 36xxx (energy)
- Hybrid inverters: registers 33xxx (basic), 34xxx (additional), 43xxx (control), 90xxx (derived)

**No RS232 profile needed.** However, consider adding a dedicated Solis profile to the
Modbus profiles directory for one-click setup:

### 4.7 Luxpower — Split Path (RS485 Modbus + Custom TCP Dongle)

Luxpower uses **Modbus RTU over RS485** for local access — this is already handled by
the existing Epilykos Modbus module with RS485 serial transport.

The **WiFi/Ethernet dongle (WL-Link)** uses a **custom TCP protocol on port 8000**
(not standard Modbus TCP). This is out of scope for the RS232 module and would be
a better fit for the `dongle` module in a future update.

**Custom TCP dongle protocol notes** (for future reference):
- Uses custom 18-byte TCP header with `0xa1 0x1a` prefix
- Wraps standard Modbus function codes (0x03 Read Holding, 0x04 Read Input)
- Well-documented in [lxp-bridge Wiki / TCP-Packet-Spec](https://github.com/celsworth/lxp-bridge/wiki/TCP-Packet-Spec)
- Full register definitions in `pylxpweb` Python library

### 4.8 SMA Sunny Boy Profile (with JS Decoder) — POSTPONED TO v2

> SMA Speedwire is deferred to v2 due to multi-chunk frame reassembly complexity.

`/home/ashipa/epilykos-dev/profiles/rs232/sma-sunnyboy.json`:

```json
{
  "name": "SMA Sunny Boy / Sunny Island",
  "protocol": "sma-speedwire",
  "transport": "rs232",
  "defaults": {
    "baud": 9600,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none"
  },
  "decoder": "sma-decoder",
  "deviceId": 1,
  "commands": [
    {
      "name": "query_power",
      "command": 0x0100,
      "fields": [
        {"offset": 0, "metric": "solar_power", "type": "uint32", "scale": 0.001, "unit": "kW"}
      ]
    },
    {
      "name": "query_energy",
      "command": 0x0132,
      "fields": [
        {"offset": 0, "metric": "daily_yield",  "type": "uint32", "scale": 0.001, "unit": "kWh"},
        {"offset": 4, "metric": "total_yield",  "type": "uint32", "scale": 0.001, "unit": "kWh"}
      ]
    },
    {
      "name": "query_grid",
      "command": 0x0042,
      "fields": [
        {"offset": 0, "metric": "grid_voltage",   "type": "uint32", "scale": 0.001, "unit": "V"},
        {"offset": 8, "metric": "grid_frequency", "type": "int32",  "scale": 0.001, "unit": "Hz"}
      ]
    }
  ]
}
```

---

## Phase 5: Decoder Modules (Binary Protocols)

### 5.1 SolaX AA55 Decoder

`/home/ashipa/epilykos-dev/modules/rs232-decoders/solax-decoder.js` — see §4.4 for profile spec and communication sequence.

### 5.2 Alpine / Alpsolar Decoder — POSTPONED (Cloud-Only)

Alpsolar uses the Inteless cloud API — no local serial protocol. Not suitable for
the RS232 module. Deferred indefinitely unless a local RS485/Modbus interface is
discovered in future models.

### 5.3 Haisic / SMK Decoder — POSTPONED (No Documentation)

No public protocol documentation exists for Haisic or SMK inverters. Integration
would require hardware-in-hand protocol analysis. Deferred indefinitely.

### 5.4 SMA Speedwire Decoder — POSTPONED TO v2

`/home/ashipa/epilykos-dev/modules/rs232-decoders/sma-decoder.js`:

```javascript
/**
 * SMA Speedwire / NET Piggy-Back Protocol Decoder
 * 
 * Reference: sbfspot (https://github.com/SBFspot/SBFspot)
 * 
 * Frame format:
 *   [0xAA] [length LSB] [length MSB] [type] [dst] [src] [ctrl] [cmd_low] [cmd_high]
 *   [...payload...] [CRC16_low] [CRC16_high]
 * 
 * Maximum payload per packet: 0x10 bytes (16 bytes)
 * Multi-packet responses need reassembly.
 */

const CRC16_TABLE = buildCRCTable(); // 256-entry lookup

function buildCRCTable() {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xA001 ^ (crc >> 1)) : (crc >> 1);
    }
    table[i] = crc;
  }
  return table;
}

function crc16(data) {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc = CRC16_TABLE[(crc ^ byte) & 0xFF] ^ (crc >> 8);
  }
  return crc;
}

function encodeQuery(command, dstAddr, srcAddr = 0xAAAA) {
  // SMA query frame
  const payload = Buffer.alloc(4);
  payload.writeUInt16LE(command, 0);
  payload.writeUInt16LE(0x0000, 2); // reserved
  
  const frame = Buffer.concat([
    Buffer.from([0xAA]),
    Buffer.alloc(2), // length placeholder
    Buffer.from([0x01]), // type: query
    Buffer.from([dstAddr & 0xFF, (dstAddr >> 8) & 0xFF]),
    Buffer.from([srcAddr & 0xFF, (srcAddr >> 8) & 0xFF]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // ctrl
    payload,
  ]);
  
  frame[1] = frame.length - 3; // length LSB (after length field)
  frame[2] = (frame.length - 3) >> 8; // length MSB
  
  const crc = crc16(frame.slice(3)); // CRC from type byte onwards
  return Buffer.concat([frame, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
}

function decodeResponse(buffer, cmd, profile) {
  // Validate header
  if (buffer.length < 8 || buffer[0] !== 0xAA) {
    throw new Error('Invalid SMA frame header');
  }
  
  // Extract payload (skip header: start+len+type+dest+src+ctrl+cmd = 14 bytes)
  const payloadOffset = 14;
  const payloadLen = buffer.length - payloadOffset - 2; // -2 for CRC
  
  // Validate CRC16
  const expectedCRC = crc16(buffer.slice(3, 3 + buffer.length - 5));
  const actualCRC = buffer.readUInt16LE(buffer.length - 2);
  if (expectedCRC !== actualCRC) {
    throw new Error('SMA CRC16 mismatch');
  }
  
  const results = {};
  for (const field of cmd.fields) {
    const offset = field.offset;
    let raw;
    if (field.type === 'uint32') {
      raw = buffer.readUInt32LE(payloadOffset + offset);
    } else if (field.type === 'int32') {
      raw = buffer.readInt32LE(payloadOffset + offset);
    }
    const value = (raw * (field.scale || 1)).toFixed(4);
    results[field.metric] = parseFloat(value);
  }
  
  return results;
}

module.exports = { encodeQuery, decodeResponse };
```

---

## Phase 6: Edge Cases & Error Handling

### 6.1 Linux Permissions

The RS232 module should detect `EACCES` errors on port open and surface a clear
message. Recommended approach: log once with installation instructions, then
debounce further errors for the same device:

```javascript
const permWarnings = new Set();
if (err.code === 'EACCES' && !permWarnings.has(device.serial_path)) {
  permWarnings.add(device.serial_path);
  logger.error(`[RS232 ${device.name}] Permission denied on ${device.serial_path}.`);
  logger.error('  → Add user to dialout group: sudo usermod -a -G dialout $USER');
  logger.error('  → Then log out and back in, or run: newgrp dialout');
}
```

### 6.2 USB-to-Serial Adaptor Detection

Many adapters (Prolific PL2303, CH340, CP2102) work on Linux but may:
- Show as `/dev/ttyUSB0`, `/dev/ttyUSB1`, etc.
- Change path on reboot if multiple adapters are plugged
- Use different chipsets requiring different drivers

**Solution:** Store the serial adapter's `pnpId` or `serialNumber` from
`SerialPort.list()` alongside the path. On port re-scan, try to find the
same device by its unique identifier.

### 6.3 Baud Rate Auto-Detection

Some users won't know their inverter's baud rate. Add a fallback: try common
rates (2400, 4800, 9600, 19200) in sequence and check for a valid response.

```javascript
const FALLBACK_BAUDS = [2400, 4800, 9600, 19200, 38400, 57600, 115200];

async function detectBaudRate(serialPath, profile) {
  for (const baud of FALLBACK_BAUDS) {
    try {
      const port = await openSerialPort({ ...profile.defaults, serial_path: serialPath, baud });
      const cmd = profile.commands[0];
      const query = typeof cmd.query === 'string' ? Buffer.from(cmd.query) : Buffer.from(cmd.query);
      const response = await queryDevice(port, query, profile, 2000);
      await closeSerialPort(port);
      // Try parsing — if it works, return the baud
      const parsed = decodeResponse(response, cmd, profile);
      if (Object.keys(parsed).length > 0) {
        return baud;
      }
    } catch (e) {
      // Try next baud
    }
  }
  throw new Error('Could not auto-detect baud rate');
}
```

### 6.4 Connection Storms (USB Re-plug)

When a USB serial adapter is unplugged and re-plugged, the OS may assign a new
`/dev/ttyUSB1` instead of `/dev/ttyUSB0`. The RS232 module should:
1. Detect the port disappearance (via chokidar or periodic port scan)
2. Look for any new port that has the same `vendorId` and `productId`
3. If found, auto-update the device config to point to the new path

### 6.5 Multiple Devices on Same Bus (RS485 Variant)

Some RS232-to-RS485 adapters allow multiple inverters on the same pair of wires.
This is technically RS485, not RS232, and the existing Modbus module handles it.
The RS232 module should NOT try to support multi-drop — that's Modbus territory.
Clearly document this boundary.

---

## Phase 7: Testing Strategy

### 7.1 Unit Tests

Create test files in `tests/`:

| Test File | What It Tests |
|-----------|---------------|
| `test-rs232-voltronic.js` | Voltronic QPIGS response parsing with sample data (also covers Infinisolar) |
| `test-rs232-vedirect.js` | VE.Direct frame parsing (key-value, checksum validation) |
| `test-rs232-solax.js` | SolaX AA55 binary frame encode/decode with checksum verification |
| `test-rs232-solis-modbus.js` | Verifies Solis Modbus registers from RS485 (uses existing Modbus test framework) |
| `test-rs232-luxpower-registers.js` | Luxpower Modbus register parsing from profile (uses existing Modbus test framework) |
| `test-rs232-port-scanner.js` | Port list + baud detection logic |
| `test-rs232-failover.js` | Consecutive failure counter, throttling, recovery |
| `test-rs232-frame-detect.js` | Frame detection callback — partial chunk buffering, multi-chunk assembly |

### 7.2 Simulated Devices

For integration testing, create a **serial port loopback simulator**:

```javascript
// tools/rs232-simulator.js
const { SerialPort } = require('serialport');
const { createServer } = require('net');
const net = require('net');
const fs = require('fs');

/**
 * RS232 Simulator — creates a pseudo-terminal pair.
 * One end is presented as a serial port (for Epilykos to connect),
 * the other end is controlled by this script to send/reply data.
 */

const { spawn } = require('child_process');

function startSimulator(protocol) {
  // Use 'socat' to create a PTY pair (install with: sudo apt install socat)
  // Alternative: use SerialPort's built-in MockBinding for unit tests:
  // const { MockBinding } = require('@serialport/binding-mock');
  // MockBinding.createPort('/tmp/epilykos-rs232-sim');
  const socat = spawn('socat', [
    'pty,link=/tmp/epilykos-rs232-sim,raw,echo=0',
    'exec:node tools/rs232-protocol-handler.js ' + protocol
  ]);
  
  console.log(`RS232 simulator running on /tmp/epilykos-rs232-sim (${protocol})`);
  console.log('Configure Epilykos RS232 device with serial_path: /tmp/epilykos-rs232-sim');
  
  return socat;
}
```

### 7.3 Manual Testing Checklist

- [ ] Add RS232 device in settings UI — port dropdown shows ports
- [ ] Select Voltronic profile, configure baud 2400, path `/dev/ttyUSB0`
- [ ] Click "Test RS232" — shows metrics or clear error message
- [ ] Select SolaX profile, configure baud 9600 — test shows live data or clear error
- [ ] Select Victron VE.Direct (streaming) — test verifies port open
- [ ] Save settings — polling begins in < 30s
- [ ] Dashboard shows RS232 inverter metrics
- [ ] Unplug USB cable — error logged, polling pauses gracefully
- [ ] Replug USB cable — polling resumes within 30s
- [ ] Remove device — polling stops, no errors
- [ ] Add second RS232 device (different inverter) — both polled
- [ ] Restart Epilykos — streaming connections clean up, no port lock errors

---

## Phase 8: Documentation & Deployment

### 8.1 README Update

Add to Epilykos README:

```markdown
## RS232 Serial Inverter Support

Epilykos supports reading data directly from inverters over RS232 serial ports.

### Supported Inverters
| **Voltronic / Axpert** (PIP, MKS, LV series) — off-grid/hybrid (also covers Infinisolar, Phocos, MUST, MPPSolar, Sako)
|- **Victron Energy** (VE.Direct port on SmartSolar, BMV, MultiPlus) — streaming
|- **SolaX** (Pocket USB, AA55 binary protocol)
|- **Solis** (via Modbus RS485 — use existing Modbus module)
|- **Luxpower** / EG4 (via Modbus RS485 — use existing Modbus module)
|- **SMA Sunny Boy / Sunny Island** — v2 planned
|- **Growatt** (ASCII serial models — via Modbus)
|- **Fronius** (older IG series)

### Hardware Requirements
- USB-to-RS232 adapter (FTDI, Prolific, CP2102)
- Linux: user must be in `dialout` group
- Connection: 3-wire (TX, RX, GND) — null modem cable may be required

### Adding a New Inverter Protocol
1. Create a profile JSON in `profiles/rs232/`
2. If binary protocol: create a decoder JS in `modules/rs232-decoders/`
3. Add tests in `tests/`
```

### 8.2 Docker Considerations

If Epilykos runs in Docker, serial port passthrough is needed:

```yaml
# docker-compose.yml
services:
  epilykos:
    # ...
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"
    group_add:
      - "dialout"
```

### 8.3 First-Run Experience

Add an onboarding hint in the settings page when no RS232 devices are configured:

```
💡 No RS232 devices configured.
Connect your inverter via a USB-to-RS232 adapter, then scan for available ports.

**Supported RS232 protocols:** Voltronic (covers Infinisolar, Phocos, MUST, Sako), Victron VE.Direct, SolaX AA55
**Supported via RS485 (existing Modbus module):** Solis, Luxpower/EG4, and all existing Modbus-compatible brands
```

---

## Implementation Timeline (Estimated)

| Phase | Effort | Description |
|-------|--------|-------------|
| Phase 0 | 0.5 hr | Verify deps, install serialport |
| Phase 1 | 3-4 hr | Core `modules/rs232.js` with poll, streaming, profiles |
| Phase 2 | 1 hr | Server.js integration, API endpoints, config key |
| Phase 3 | 2-3 hr | Settings UI: HTML tab, JS rendering, form collection |
| Phase 4 | 2-3 hr | Voltronic + Victron + SolaX + Infinisolar alias profile JSON files, SolaX binary decoder |
| Phase 5 | 1 hr | rs232-utils.js helper; SMA/Goodwe/Alpsolar/Haisic/SMK deferred to v2 |
| Phase 6 | 1 hr | Permissions, port detection, baud auto-detect |
| Phase 7 | 1-2 hr | Tests, simulator, manual testing (includes Solis/Luxpower Modbus verification tests) |
| Phase 8 | 0.5 hr | README, docs, Docker example |
| **Total** | **11-15 hr** | (Solis, Luxpower, Infinisolar require 0 additional code — covered by existing modules) |

---

## Appendix: Key Files to Modify

| File | What Changes |
|------|-------------|
| `package.json` | Add `serialport@^8.0.0` to dependencies |
| `modules/rs232.js` | **NEW** — main RS232 module |
| `modules/rs232-decoders/solax-decoder.js` | **NEW** — SolaX AA55 binary decoder |
| `modules/rs232-decoders/rs232-utils.js` | **NEW** — CRC, byte utils, port helpers |
| `modules/rs232-decoders/sma-decoder.js` | **NEW** — SMA binary decoder *(POSTPONED to v2)* |
| `profiles/rs232/voltronic-qpigs.json` | **NEW** — Voltronic/Phocos/MUST/Sako profile |
| `profiles/rs232/vedirect.json` | **NEW** — Victron VE.Direct profile |
| `profiles/rs232/solax-pocket-usb.json` | **NEW** — SolaX AA55 profile |
| `profiles/rs232/infinisolar-alias.json` | **NEW** — Infinisolar alias pointing to voltronic profile (zero-code) |
| `profiles/rs232/sma-sunnyboy.json` | **NEW** — SMA profile *(POSTPONED to v2)* |
|
| **Brands handled by existing Modbus module (no RS232 module changes):** |
| Solis | Modbus RTU over RS485 — use existing Modbus module + serial transport |
| Luxpower (RS485 path) | Modbus RTU over RS485 — use existing Modbus module + serial transport |
| Luxpower (TCP dongle) | Custom TCP — future dongle module addition |
| Alpsolar | Cloud-only (Inteless API) — deferred / not suitable |
| Lvtopsun | Battery manufacturer — not applicable |
| Haisic | No protocol documentation available — deferred |
| SMK | No protocol documentation available — deferred |

| `modules/database.js` | Add `rs232_devices` to essentialKeys |
| `server.js` | Import, init, poll call, 3 API routes, settings save hook |
| `public/settings.html` | Add RS232 subtab div + nav button |
| `public/settings.js` | Add rendering functions, form collection, load integration |
