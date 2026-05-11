const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');
const backupStatus = document.getElementById('backup-status');

function showStatus(element, msg, type) {
  element.textContent = msg;
  element.className = `status ${type}`;
  if (type !== 'info') {
    setTimeout(() => { element.textContent = ''; element.className = 'status'; }, 5000);
  }
}

// ── Load existing settings (all config keys) ──────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    // Populate top‑level fields
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('ha_devices') || key.startsWith('mqtt_devices') || key.startsWith('modbus_devices') || key === 'dashboard_config') continue;
      const input = form.querySelector(`[name="${key}"]`);
      if (input) {
        if (input.type === 'checkbox') {
          input.checked = value === 'true';
        } else {
          input.value = value;
        }
      }
    }
    // Build device lists
    buildHaDeviceList(JSON.parse(data.ha_devices || '[]'));
    buildMqttDeviceList(JSON.parse(data.mqtt_devices || '[]'));
    buildModbusDeviceList(JSON.parse(data.modbus_devices || '[]'));
    // Dashboard config
    const dashConfig = data.dashboard_config ? JSON.parse(data.dashboard_config) : null;
    if (dashConfig) buildDashboardEditor(dashConfig);
    else buildDashboardEditor(null);
  } catch (e) {
    showStatus(saveStatus, 'Failed to load settings', 'error');
  }
}

// ── Home Assistant Devices ─────────────────────────────────────────────────
let haDeviceCounter = 0;
function buildHaDeviceList(devices) {
  const container = document.getElementById('ha-devices-container');
  container.innerHTML = '';
  haDeviceCounter = devices.length;
  devices.forEach((dev, idx) => renderHaDevice(dev, idx));
}

function renderHaDevice(device, idx) {
  const container = document.getElementById('ha-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="ha_devices[${idx}][name]" placeholder="Device Name" value="${device.name || ''}" style="width:auto; flex:1;">
      <label style="margin:0 1rem;"><input type="checkbox" name="ha_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-ha">Remove</button>
    </div>
    <div class="form-row">
      <input type="text" name="ha_devices[${idx}][url]" placeholder="http://homeassistant.local:8123" value="${device.url || ''}">
      <input type="password" name="ha_devices[${idx}][token]" placeholder="Access Token" value="${device.token || ''}">
    </div>
    <div class="form-row">
      <input type="number" name="ha_devices[${idx}][poll_interval]" placeholder="Poll Interval (s)" value="${device.poll_interval || 30}" style="width:120px;">
      <button type="button" class="fetch-btn fetch-ha-entities" data-device="${idx}">Fetch Entities</button>
      <span class="test-status" id="ha-entities-status-${idx}"></span>
    </div>
    <div class="mappings-section" id="ha-mappings-${idx}">
      ${renderEntityMappings(device.entities || {}, idx)}
    </div>
  `;
  container.appendChild(card);

  card.querySelector('[data-action="remove-ha"]').addEventListener('click', () => {
    card.remove();
    reindexHa();
  });

  card.querySelector('.fetch-ha-entities').addEventListener('click', async function() {
    const statusEl = document.getElementById(`ha-entities-status-${idx}`);
    const url = card.querySelector(`[name="ha_devices[${idx}][url]"]`).value;
    const token = card.querySelector(`[name="ha_devices[${idx}][token]"]`).value;
    if (!url || !token) {
      showStatus(statusEl, 'URL and token required', 'error');
      return;
    }
    showStatus(statusEl, 'Fetching...', 'info');
    try {
      const res = await fetch(`/api/ha-device-entities?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`);
      const entities = await res.json();
      if (!res.ok) throw new Error(entities.error || 'Failed');
      // Populate dropdowns in mappings section
      const selects = document.querySelectorAll(`#ha-mappings-${idx} select`);
      selects.forEach(select => {
        const currentVal = select.value;
        select.innerHTML = '<option value="">-- Select entity --</option>';
        entities.sort().forEach(id => {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = id;
          select.appendChild(opt);
        });
        if (currentVal) select.value = currentVal;
      });
      showStatus(statusEl, 'Entities loaded!', 'success');
    } catch (e) {
      showStatus(statusEl, e.message, 'error');
    }
  });
}

function renderEntityMappings(entities, idx) {
  const metrics = [
    'consumption', 'solar', 'battery_charge', 'battery_discharge',
    'grid_import', 'grid_export', 'battery_soc',
    'daily_consumption', 'daily_solar', 'daily_battery_charge',
    'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export',
    'battery_voltage', 'inverter_temp', 'solar_voltage', 'load_power',
    'grid_status' // special, handled separately
  ];
  let html = '';
  metrics.forEach(metric => {
    if (metric === 'grid_status') return; // handled by global config
    html += `
      <div class="metric-row">
        <label>${metric.replace(/_/g, ' ')}</label>
        <select name="ha_devices[${idx}][entities][${metric}]">
          <option value="">--</option>
          ${entities[metric] ? `<option value="${entities[metric]}" selected>${entities[metric]}</option>` : ''}
        </select>
      </div>
    `;
  });
  return html;
}

function reindexHa() {
  const cards = document.querySelectorAll('#ha-devices-container .device-card');
  haDeviceCounter = cards.length;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    // Update name attributes...
    // This is simplified; a full implementation would rename all inputs.
  });
}

document.getElementById('add-ha-device').addEventListener('click', () => {
  const container = document.getElementById('ha-devices-container');
  const idx = haDeviceCounter++;
  renderHaDevice({ name: '', url: '', token: '', enabled: true, poll_interval: 30, entities: {} }, idx);
});

// ── MQTT Devices (similar structure) ──────────────────────────────────────
let mqttDeviceCounter = 0;
function buildMqttDeviceList(devices) {
  const container = document.getElementById('mqtt-devices-container');
  container.innerHTML = '';
  mqttDeviceCounter = devices.length;
  devices.forEach((dev, idx) => renderMqttDevice(dev, idx));
}

function renderMqttDevice(device, idx) {
  const container = document.getElementById('mqtt-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="mqtt_devices[${idx}][name]" placeholder="Broker Name" value="${device.name || ''}" style="width:auto; flex:1;">
      <label style="margin:0 1rem;"><input type="checkbox" name="mqtt_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-mqtt">Remove</button>
    </div>
    <div class="form-row">
      <input type="text" name="mqtt_devices[${idx}][broker]" placeholder="mqtt://broker.local:1883" value="${device.broker || ''}">
    </div>
    <div class="form-row">
      <input type="text" name="mqtt_devices[${idx}][username]" placeholder="Username" value="${device.username || ''}">
      <input type="password" name="mqtt_devices[${idx}][password]" placeholder="Password" value="${device.password || ''}">
    </div>
    <div class="test-row">
      <button type="button" class="fetch-btn test-mqtt-broker">Test Broker</button>
      <span class="test-status" id="mqtt-broker-status-${idx}"></span>
    </div>
    <div class="test-row">
      <input type="text" class="test-topic-input" placeholder="Test Topic">
      <button type="button" class="fetch-btn test-mqtt-topic">Test Topic</button>
      <span class="test-status" id="mqtt-topic-status-${idx}"></span>
    </div>
    <div class="mappings-section">
      <h4>Topic Mappings</h4>
      ${renderMqttTopicMappings(device.topics || {}, idx)}
    </div>
  `;
  container.appendChild(card);
  // Event listeners for tests...
}

function renderMqttTopicMappings(topics, idx) {
  // Similar to HA metrics
  return '';
}

document.getElementById('add-mqtt-device').addEventListener('click', () => {
  // similar
});

// ── Modbus Devices (existing logic, unchanged) ──
// ... (same as original settings.js, but using modbus_devices array)

// ── Dashboard Editor ───────────────────────────────────────────────────────
function buildDashboardEditor(config) {
  const listEl = document.getElementById('dashboards-list');
  listEl.innerHTML = '';
  if (!config || !config.dashboards) return;

  const activeId = config.activeDashboard || config.dashboards[0]?.id;
  config.dashboards.forEach(db => {
    const row = document.createElement('div');
    row.className = 'dash-row';
    row.innerHTML = `
      <input type="text" value="${db.name}" data-db-id="${db.id}" class="dash-name">
      <button type="button" class="fetch-btn set-active" data-id="${db.id}">${db.id === activeId ? '★ Active' : 'Set Active'}</button>
      <button type="button" class="remove-btn delete-dash" data-id="${db.id}">Del</button>
    `;
    listEl.appendChild(row);
  });

  // Build editor for active dashboard
  const activeDb = config.dashboards.find(db => db.id === activeId);
  if (activeDb) renderDashboardBlockEditor(activeDb);
}

function renderDashboardBlockEditor(dashboard) {
  const container = document.getElementById('active-dashboard-editor');
  container.innerHTML = `<h4>Editing: ${dashboard.name}</h4>`;
  const blockList = document.createElement('ul');
  blockList.className = 'block-list';
  dashboard.layout.forEach((block, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="drag-handle">☰</span>
      <select class="block-type-select">
        <option value="flow-card" ${block.type === 'flow-card' ? 'selected' : ''}>Flow Card</option>
        <option value="metric-cards" ${block.type === 'metric-cards' ? 'selected' : ''}>Metric Cards</option>
        <option value="grid-card" ${block.type === 'grid-card' ? 'selected' : ''}>Grid Card</option>
        <option value="chart-power" ${block.type === 'chart-power' ? 'selected' : ''}>Power Chart</option>
        <option value="chart-energy" ${block.type === 'chart-energy' ? 'selected' : ''}>Energy Chart</option>
        <option value="savings-summary" ${block.type === 'savings-summary' ? 'selected' : ''}>Savings Summary</option>
        <option value="data-table-daily" ${block.type === 'data-table-daily' ? 'selected' : ''}>Daily Table</option>
        <option value="data-table-monthly" ${block.type === 'data-table-monthly' ? 'selected' : ''}>Monthly Table</option>
      </select>
      <button type="button" class="remove-btn delete-block">Remove</button>
    `;
    blockList.appendChild(li);
  });
  container.appendChild(blockList);
  const addBlockBtn = document.createElement('button');
  addBlockBtn.textContent = '+ Add Block';
  addBlockBtn.className = 'fetch-btn';
  container.appendChild(addBlockBtn);
  // Event listeners for add block, remove block, reorder (simplified)
}

// (Backup, restore, forecast test handlers remain same as original)

// ── Form submission ───────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // Collect all inputs into a flat object, including JSON arrays for devices and dashboard_config
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  // Build arrays from indexed fields (simplified: we need a proper collect function)
  // For brevity, the final version would have proper collection logic.
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      showStatus(saveStatus, 'Settings saved successfully!', 'success');
    } else {
      showStatus(saveStatus, 'Failed to save settings', 'error');
    }
  } catch (e) {
    showStatus(saveStatus, 'Error: ' + e.message, 'error');
  }
});

loadSettings();
