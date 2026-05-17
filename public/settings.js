// settings.js – fixed to use /api/metrics/list for immediate dropdown updates
const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');
const backupStatus = document.getElementById('backup-status');
let usedDashboardMetrics = [];
let allMetrics = []; // array of { name, unit, value?, timestamp? }

function showStatus(element, msg, type) {
  element.textContent = msg;
  element.className = `status ${type}`;
  if (type !== 'info') {
    setTimeout(() => { element.textContent = ''; element.className = 'status'; }, 5000);
  }
}


// ── Load existing settings ─────────────────────────────────────────────────
async function loadSettings() {
  try {
    // FIRST: fetch all metrics (including those without data)
    const metricsRes = await fetch('/api/metrics/list');
    if (metricsRes.ok) {
      allMetrics = await metricsRes.json();
      allMetrics.sort((a,b) => a.name.localeCompare(b.name));
    }

    // THEN fetch all settings
    const res = await fetch('/api/settings');
    const data = await res.json();
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('ha_devices') || key.startsWith('mqtt_devices') || key.startsWith('modbus_devices') || key === 'dashboard_config' || key === 'external_sources' || key === 'bms_devices') continue;
      const input = form.querySelector(`[name="${key}"]`);
      if (input) {
        if (input.type === 'checkbox') input.checked = value === 'true';
        else input.value = value;
      }
    }
    buildHaDeviceList(JSON.parse(data.ha_devices || '[]'));
    buildMqttDeviceList(JSON.parse(data.mqtt_devices || '[]'));
    buildModbusDeviceList(JSON.parse(data.modbus_devices || '[]'));
    buildExternalSourceList(JSON.parse(data.external_sources || '[]'));
    buildBmsDeviceList(JSON.parse(data.bms_devices || '[]'));
    const dashConfig = data.dashboard_config ? JSON.parse(data.dashboard_config) : null;
    buildDashboardEditor(dashConfig);

    usedDashboardMetrics = [];
    if (dashConfig && dashConfig.dashboards) {
      dashConfig.dashboards.forEach(db => {
        db.layout.forEach(block => {
          if (block.type === 'metric-cards' && block.cards) {
            block.cards.forEach(card => {
              if (card.metric && !usedDashboardMetrics.includes(card.metric)) usedDashboardMetrics.push(card.metric);
            });
          }
        });
      });
      usedDashboardMetrics.sort();
    }
  } catch (e) {
    showStatus(saveStatus, 'Failed to load settings', 'error');
  }
}

// ---------- Helper: Create metric dropdown ----------
function createMetricDropdown(selectedMetric = '') {
  const select = document.createElement('select');
  select.className = 'metric-name';
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Select Metric --';
  select.appendChild(emptyOpt);
  for (const metric of allMetrics) {
    const opt = document.createElement('option');
    opt.value = metric.name;
    opt.textContent = metric.unit ? `${metric.name} (${metric.unit})` : metric.name;
    if (metric.name === selectedMetric) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

// Generate metric options as HTML string (for innerHTML-based config panels)
function generateMetricOptionsHtml(selectedMetric, label) {
  let html = `<option value="">-- ${escapeHtml(label || 'Select metric')} --</option>`;
  for (const m of allMetrics) {
    const sel = selectedMetric === m.name ? ' selected' : '';
    const unitStr = m.unit ? ` (${escapeHtml(m.unit)})` : '';
    html += `<option value="${escapeHtml(m.name)}"${sel}>${escapeHtml(m.name)}${unitStr}</option>`;
  }
  return html;
}

// Helper to refresh all metric dropdowns after a new metric is created
async function refreshAllMetricDropdowns() {
  const res = await fetch('/api/metrics/list');
  if (res.ok) {
    allMetrics = await res.json();
    allMetrics.sort((a,b) => a.name.localeCompare(b.name));
  }
  const selects = document.querySelectorAll('.metric-name');
  for (const select of selects) {
    const currentVal = select.value;
    select.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- Select Metric --';
    select.appendChild(emptyOpt);
    for (const metric of allMetrics) {
      const opt = document.createElement('option');
      opt.value = metric.name;
      opt.textContent = metric.unit ? `${metric.name} (${metric.unit})` : metric.name;
      select.appendChild(opt);
    }
    if (currentVal && allMetrics.some(m => m.name === currentVal)) select.value = currentVal;
  }
}

// ======================== HOME ASSISTANT ========================
let haDeviceCounter = 0;
function buildHaDeviceList(devices) {
  const container = document.getElementById('ha-devices-container');
  container.innerHTML = '';
  haDeviceCounter = 0;
  devices.forEach((dev, idx) => renderHaDevice(dev, idx));
}

function renderHaDevice(device, idx) {
  const container = document.getElementById('ha-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="ha_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <label style="margin:0 1rem;"><input type="checkbox" name="ha_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-ha">Remove</button>
    </div>
    <div class="form-row">
      <input type="text" name="ha_devices[${idx}][url]" placeholder="http://homeassistant.local:8123" value="${escapeHtml(device.url || '')}">
      <input type="password" name="ha_devices[${idx}][token]" placeholder="Access Token" value="${escapeHtml(device.token || '')}">
    </div>
    <div class="form-row">
      <input type="number" name="ha_devices[${idx}][poll_interval]" placeholder="Poll Interval (s)" value="${device.poll_interval || 30}" style="width:120px;">
      <button type="button" class="fetch-btn fetch-ha-entities">Fetch Entities</button>
      <span class="test-status" id="ha-entities-status-${idx}"></span>
    </div>
    <div class="mappings-section" id="ha-mappings-${idx}">
      <h4>Entity Mappings</h4>
      <div class="mappings-list" id="ha-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn add-ha-metric" data-device="${idx}">
        + Add Metric Mapping
        <span class="metric-help-icon" data-tooltip="${escapeHtml(allMetrics.map(m => m.name).join(', ') || 'none yet')}">?</span>
      </button>
    </div>
  `;
  container.appendChild(card);

  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'metric-tooltip';
  tooltipEl.style.display = 'none';
  card.appendChild(tooltipEl);

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
      const selects = card.querySelectorAll('.mappings-list select.entity-select');
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

  card.querySelector('.add-ha-metric').addEventListener('click', () => {
    addHaMetricRow(device, idx);
  });

  const helpIcon = card.querySelector('.metric-help-icon');
  if (helpIcon) {
    helpIcon.addEventListener('mouseenter', (e) => {
      const text = allMetrics.map(m => m.name).join(', ');
      if (!text) return;
      const tooltip = card.querySelector('.metric-tooltip');
      tooltip.textContent = 'Available metrics: ' + text;
      tooltip.style.display = 'block';
      const rect = helpIcon.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      tooltip.style.left = (rect.left - cardRect.left + 20) + 'px';
      tooltip.style.top = (rect.top - cardRect.top - 30) + 'px';
    });
    helpIcon.addEventListener('mouseleave', () => {
      const tooltip = card.querySelector('.metric-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    });
  }

  const mappingsList = card.querySelector('.mappings-list');
  renderHaMappings(device.entities || {}, idx, mappingsList);
  haDeviceCounter++;
}

function renderHaMappings(entities, deviceIdx, container) {
  container.innerHTML = '';
  Object.entries(entities).forEach(([metric, entityId]) => {
    addHaMetricRow({}, deviceIdx, container, metric, entityId);
  });
  if (Object.keys(entities).length === 0) addHaMetricRow({}, deviceIdx, container);
}

function addHaMetricRow(device, deviceIdx, container, metric = '', entityId = '') {
  if (!container) container = document.getElementById(`ha-mappings-list-${deviceIdx}`);
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'metric-row';
  const metricSelect = createMetricDropdown(metric);
  const entitySelect = document.createElement('select');
  entitySelect.className = 'entity-select';
  entitySelect.innerHTML = '<option value="">-- Select entity --</option>';
  if (entityId) {
    const opt = document.createElement('option');
    opt.value = entityId;
    opt.textContent = entityId;
    opt.selected = true;
    entitySelect.appendChild(opt);
  }
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn remove-metric';
  removeBtn.textContent = '−';
  removeBtn.addEventListener('click', () => row.remove());
  row.appendChild(metricSelect);
  row.appendChild(entitySelect);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function reindexHa() {
  const cards = document.querySelectorAll('#ha-devices-container .device-card');
  haDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    const nameInput = card.querySelector('.device-header input[type="text"]');
    if (nameInput) nameInput.name = `ha_devices[${i}][name]`;
    const enableCb = card.querySelector('.device-header input[type="checkbox"]');
    if (enableCb) enableCb.name = `ha_devices[${i}][enabled]`;
    const urlInput = card.querySelector(`[name^="ha_devices["] [name$="[url]"]`);
    if (urlInput) urlInput.name = `ha_devices[${i}][url]`;
    const tokenInput = card.querySelector(`[name^="ha_devices["] [name$="[token]"]`);
    if (tokenInput) tokenInput.name = `ha_devices[${i}][token]`;
    const pollInput = card.querySelector(`[name^="ha_devices["] [name$="[poll_interval]"]`);
    if (pollInput) pollInput.name = `ha_devices[${i}][poll_interval]`;
    const addBtn = card.querySelector('.add-ha-metric');
    if (addBtn) addBtn.dataset.device = i;
    haDeviceCounter++;
  });
}

const addHaBtn = document.getElementById('add-ha-device');
if (addHaBtn) addHaBtn.addEventListener('click', () => {
  const idx = haDeviceCounter;
  renderHaDevice({ name: '', url: '', token: '', enabled: true, poll_interval: 30, entities: {} }, idx);
});

// ======================== MQTT ========================
let mqttDeviceCounter = 0;
function buildMqttDeviceList(devices) {
  const container = document.getElementById('mqtt-devices-container');
  container.innerHTML = '';
  mqttDeviceCounter = 0;
  devices.forEach((dev, idx) => renderMqttDevice(dev, idx));
}

function renderMqttDevice(device, idx) {
  const container = document.getElementById('mqtt-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="mqtt_devices[${idx}][name]" placeholder="Broker Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <label style="margin:0 1rem;"><input type="checkbox" name="mqtt_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-mqtt">Remove</button>
    </div>
    <div class="form-row">
      <input type="text" name="mqtt_devices[${idx}][broker]" placeholder="mqtt://broker.local:1883" value="${escapeHtml(device.broker || '')}">
    </div>
    <div class="form-row">
      <input type="text" name="mqtt_devices[${idx}][username]" placeholder="Username" value="${escapeHtml(device.username || '')}">
      <input type="password" name="mqtt_devices[${idx}][password]" placeholder="Password" value="${escapeHtml(device.password || '')}">
    </div>
    <div class="test-row">
      <button type="button" class="fetch-btn test-mqtt-broker">Test Broker</button>
      <span class="test-status" id="mqtt-broker-status-${idx}"></span>
    </div>
    <div class="test-row">
      <input type="text" class="test-topic-input" placeholder="Test Topic">
      <button type="button" class="fetch-btn test-mqtt-topic-btn">Test Topic</button>
      <span class="test-status" id="mqtt-topic-status-${idx}"></span>
    </div>
    <div class="mappings-section">
      <h4>Topic Mappings</h4>
      <div class="mappings-list" id="mqtt-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn add-mqtt-metric" data-device="${idx}">
        + Add Metric Mapping
        <span class="metric-help-icon" data-tooltip="${escapeHtml(allMetrics.map(m => m.name).join(', ') || 'none yet')}">?</span>
      </button>
    </div>
  `;
  container.appendChild(card);

  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'metric-tooltip';
  tooltipEl.style.display = 'none';
  card.appendChild(tooltipEl);

  card.querySelector('[data-action="remove-mqtt"]').addEventListener('click', () => {
    card.remove();
    reindexMqtt();
  });

  card.querySelector('.test-mqtt-broker').addEventListener('click', async function(e) {
    e.preventDefault();
    const statusEl = document.getElementById(`mqtt-broker-status-${idx}`);
    showStatus(statusEl, 'Testing...', 'info');
    try {
      const res = await fetch('/api/test-mqtt');
      const data = await res.json();
      if (res.ok) showStatus(statusEl, data.message, 'success');
      else showStatus(statusEl, data.error || 'Test failed', 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  card.querySelector('.test-mqtt-topic-btn').addEventListener('click', async function(e) {
    e.preventDefault();
    const statusEl = document.getElementById(`mqtt-topic-status-${idx}`);
    const topic = card.querySelector('.test-topic-input').value.trim();
    if (!topic) {
      showStatus(statusEl, 'Enter a topic', 'error');
      return;
    }
    showStatus(statusEl, 'Waiting for message...', 'info');
    try {
      const res = await fetch(`/api/test-mqtt-topic?topic=${encodeURIComponent(topic)}`);
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `Received: ${data.value ?? data.raw}`, 'success');
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  card.querySelector('.add-mqtt-metric').addEventListener('click', () => {
    addMqttMetricRow(device, idx);
  });

  const helpIcon = card.querySelector('.metric-help-icon');
  if (helpIcon) {
    helpIcon.addEventListener('mouseenter', (e) => {
      const text = allMetrics.map(m => m.name).join(', ');
      if (!text) return;
      const tooltip = card.querySelector('.metric-tooltip');
      tooltip.textContent = 'Available metrics: ' + text;
      tooltip.style.display = 'block';
      const rect = helpIcon.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      tooltip.style.left = (rect.left - cardRect.left + 20) + 'px';
      tooltip.style.top = (rect.top - cardRect.top - 30) + 'px';
    });
    helpIcon.addEventListener('mouseleave', () => {
      const tooltip = card.querySelector('.metric-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    });
  }

  const mappingsList = card.querySelector('.mappings-list');
  renderMqttMappings(device.topics || {}, idx, mappingsList);
  mqttDeviceCounter++;
}

function renderMqttMappings(topics, deviceIdx, container) {
  container.innerHTML = '';
  Object.entries(topics).forEach(([metric, topic]) => {
    addMqttMetricRow({}, deviceIdx, container, metric, topic);
  });
  if (Object.keys(topics).length === 0) addMqttMetricRow({}, deviceIdx, container);
}

function addMqttMetricRow(device, deviceIdx, container, metric = '', topic = '') {
  if (!container) container = document.getElementById(`mqtt-mappings-list-${deviceIdx}`);
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'metric-row';
  const metricSelect = createMetricDropdown(metric);
  const topicInput = document.createElement('input');
  topicInput.type = 'text';
  topicInput.className = 'topic-input';
  topicInput.placeholder = 'topic';
  topicInput.value = topic;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn remove-metric';
  removeBtn.textContent = '−';
  removeBtn.addEventListener('click', () => row.remove());
  row.appendChild(metricSelect);
  row.appendChild(topicInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function reindexMqtt() {
  const cards = document.querySelectorAll('#mqtt-devices-container .device-card');
  mqttDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    mqttDeviceCounter++;
  });
}

const addMqttBtn = document.getElementById('add-mqtt-device');
if (addMqttBtn) addMqttBtn.addEventListener('click', () => {
  const idx = mqttDeviceCounter;
  renderMqttDevice({ name: '', broker: '', username: '', password: '', enabled: true, topics: {} }, idx);
});

// ======================== MODBUS ========================
let modbusDeviceCounter = 0;
function buildModbusDeviceList(devices) {
  const container = document.getElementById('modbus-devices-container');
  container.innerHTML = '';
  modbusDeviceCounter = 0;
  devices.forEach((dev, idx) => renderModbusDevice(dev, idx));
}

function renderModbusDevice(device, idx) {
  const container = document.getElementById('modbus-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="modbus_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <label><input type="checkbox" name="modbus_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-modbus">Remove</button>
    </div>
    <div class="form-row">
      <select name="modbus_devices[${idx}][transport]" class="modbus-transport-select">
        <option value="tcp" ${device.transport === 'tcp' ? 'selected' : ''}>TCP/IP</option>
        <option value="serial" ${device.transport === 'serial' ? 'selected' : ''}>Serial (USB/RS485)</option>
      </select>
      <select name="modbus_devices[${idx}][profile]" class="modbus-profile-select">
        <option value="">-- Select profile --</option>
      </select>
    </div>
    <div class="modbus-tcp-fields" style="${device.transport === 'tcp' ? '' : 'display:none;'}">
      <div class="form-row">
        <input type="text" name="modbus_devices[${idx}][host]" placeholder="Host/IP" value="${escapeHtml(device.host || '')}">
        <input type="number" name="modbus_devices[${idx}][port]" placeholder="Port" value="${device.port || 502}">
      </div>
    </div>
    <div class="modbus-serial-fields" style="${device.transport === 'serial' ? '' : 'display:none;'}">
      <div class="form-row">
        <input type="text" name="modbus_devices[${idx}][serial_path]" placeholder="Serial path (e.g., /dev/ttyUSB0)" value="${escapeHtml(device.serial_path || '/dev/ttyUSB0')}">
        <input type="number" name="modbus_devices[${idx}][serial_baud]" placeholder="Baud rate" value="${device.serial_baud || 9600}">
      </div>
      <div class="form-row">
        <input type="number" name="modbus_devices[${idx}][serial_data_bits]" placeholder="Data bits" value="${device.serial_data_bits || 8}">
        <select name="modbus_devices[${idx}][serial_parity]">
          <option value="none" ${device.serial_parity === 'none' ? 'selected' : ''}>None</option>
          <option value="even" ${device.serial_parity === 'even' ? 'selected' : ''}>Even</option>
          <option value="odd" ${device.serial_parity === 'odd' ? 'selected' : ''}>Odd</option>
        </select>
        <input type="number" name="modbus_devices[${idx}][serial_stop_bits]" placeholder="Stop bits" value="${device.serial_stop_bits || 1}">
      </div>
    </div>
    <div class="form-row">
      <input type="number" name="modbus_devices[${idx}][unit]" placeholder="Unit ID" value="${device.unit || 1}">
      <input type="number" name="modbus_devices[${idx}][poll_interval]" placeholder="Poll (s)" value="${device.poll_interval || 30}" style="width:120px;">
      <button type="button" class="fetch-btn test-modbus">Test Modbus</button>
    </div>
  `;
  container.appendChild(card);

  const transportSelect = card.querySelector('.modbus-transport-select');
  const tcpFields = card.querySelector('.modbus-tcp-fields');
  const serialFields = card.querySelector('.modbus-serial-fields');
  transportSelect.addEventListener('change', (e) => {
    const isTcp = e.target.value === 'tcp';
    tcpFields.style.display = isTcp ? '' : 'none';
    serialFields.style.display = isTcp ? 'none' : '';
  });
  const profileSelect = card.querySelector('.modbus-profile-select');
  fetch('/api/modbus/profiles').then(r => r.json()).then(profiles => {
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === device.profile) opt.selected = true;
      profileSelect.appendChild(opt);
    });
  });
  card.querySelector('[data-action="remove-modbus"]').addEventListener('click', () => {
    card.remove();
    reindexModbus();
  });
  card.querySelector('.test-modbus').addEventListener('click', async function() {
    const statusEl = document.createElement('span');
    statusEl.className = 'test-status';
    this.after(statusEl);
    const dev = {
      transport: transportSelect.value,
      host: card.querySelector('input[name$="[host]"]')?.value,
      port: card.querySelector('input[name$="[port]"]')?.value,
      serial_path: card.querySelector('input[name$="[serial_path]"]')?.value,
      serial_baud: card.querySelector('input[name$="[serial_baud]"]')?.value,
      serial_data_bits: card.querySelector('input[name$="[serial_data_bits]"]')?.value,
      serial_parity: card.querySelector('select[name$="[serial_parity]"]')?.value,
      serial_stop_bits: card.querySelector('input[name$="[serial_stop_bits]"]')?.value,
      unit: card.querySelector('input[name$="[unit]"]')?.value,
    };
    try {
      const res = await fetch('/api/test-modbus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dev) });
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `OK: ${data.value}`, 'success');
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });
  modbusDeviceCounter++;
}

function reindexModbus() {
  const cards = document.querySelectorAll('#modbus-devices-container .device-card');
  modbusDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    modbusDeviceCounter++;
  });
}
const addModbusBtn = document.getElementById('add-modbus-device');
if (addModbusBtn) addModbusBtn.addEventListener('click', () => {
  const idx = modbusDeviceCounter;
  renderModbusDevice({ name: '', host: '', port: 502, unit: 1, poll_interval: 30, enabled: true, profile: '', transport: 'tcp' }, idx);
});

// ======================== EXTERNAL REST SOURCES ========================
let externalSourceCounter = 0;
function buildExternalSourceList(sources) {
  const container = document.getElementById('external-sources-container');
  if (!container) return;
  container.innerHTML = '';
  externalSourceCounter = 0;
  sources.forEach((src, idx) => renderExternalSource(src, idx));
}
function renderExternalSource(source, idx) {
  const container = document.getElementById('external-sources-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="external_sources[${idx}][name]" placeholder="Source Name" value="${escapeHtml(source.name || '')}" style="flex:1;">
      <label><input type="checkbox" name="external_sources[${idx}][enabled]" ${source.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-external">Remove</button>
    </div>
    <div class="form-row">
      <input type="text" name="external_sources[${idx}][url]" placeholder="URL" value="${escapeHtml(source.url || '')}">
    </div>
    <div class="mappings-section">
      <h4>Metric Mappings (JSON path → metric name)</h4>
      <div class="mappings-list" id="external-mappings-list-${idx}"></div>
      <button type="button" class="fetch-btn add-external-metric" data-device="${idx}">+ Add Mapping</button>
      <div class="test-row" style="margin-top:0.5rem;">
        <input type="text" class="test-jsonpath" placeholder="JSON path to test (e.g., data.temperature)">
        <button type="button" class="fetch-btn test-external">Test</button>
        <span class="test-status" id="external-test-status-${idx}"></span>
      </div>
    </div>
  `;
  container.appendChild(card);
  card.querySelector('[data-action="remove-external"]').addEventListener('click', () => {
    card.remove();
    reindexExternal();
  });
  const mappingsList = card.querySelector('.mappings-list');
  renderExternalMappings(source.mappings || {}, idx, mappingsList);
  card.querySelector('.add-external-metric').addEventListener('click', () => {
    addExternalMetricRow(idx, mappingsList);
  });
  const testBtn = card.querySelector('.test-external');
  const testPathInput = card.querySelector('.test-jsonpath');
  const testStatus = card.querySelector(`#external-test-status-${idx}`);
  testBtn.addEventListener('click', async () => {
    const url = card.querySelector('input[name$="[url]"]').value;
    const jsonPath = testPathInput.value.trim();
    if (!url) { showStatus(testStatus, 'URL required', 'error'); return; }
    showStatus(testStatus, 'Testing...', 'info');
    try {
      const res = await fetch('/api/test-external', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, jsonPath }) });
      const data = await res.json();
      if (res.ok) showStatus(testStatus, `Value: ${data.value}`, 'success');
      else showStatus(testStatus, data.error, 'error');
    } catch (err) {
      showStatus(testStatus, err.message, 'error');
    }
  });
  externalSourceCounter++;
}
function renderExternalMappings(mappings, deviceIdx, container) {
  container.innerHTML = '';
  Object.entries(mappings).forEach(([jsonPath, metric]) => {
    addExternalMetricRow(deviceIdx, container, jsonPath, metric);
  });
  if (Object.keys(mappings).length === 0) addExternalMetricRow(deviceIdx, container);
}
function addExternalMetricRow(deviceIdx, container, jsonPath = '', metric = '') {
  const row = document.createElement('div');
  row.className = 'metric-row';
  const jsonPathInput = document.createElement('input');
  jsonPathInput.type = 'text';
  jsonPathInput.className = 'jsonpath';
  jsonPathInput.placeholder = 'JSON path (e.g., data.temperature)';
  jsonPathInput.value = jsonPath;
  const metricSelect = createMetricDropdown(metric);
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn remove-metric';
  removeBtn.textContent = '−';
  removeBtn.addEventListener('click', () => row.remove());
  row.appendChild(jsonPathInput);
  row.appendChild(metricSelect);
  row.appendChild(removeBtn);
  container.appendChild(row);
}
function reindexExternal() {
  const cards = document.querySelectorAll('#external-sources-container .device-card');
  externalSourceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    externalSourceCounter++;
  });
}
const addExternalBtn = document.getElementById('add-external-source');
if (addExternalBtn) addExternalBtn.addEventListener('click', () => {
  const idx = externalSourceCounter;
  renderExternalSource({ name: '', url: '', enabled: true, mappings: {} }, idx);
});

// ======================== BLUETOOTH BMS (with scan button, dynamic bridge URL) ========================
let bmsDeviceCounter = 0;
function buildBmsDeviceList(devices) {
  const container = document.getElementById('bms-devices-container');
  if (!container) return;
  container.innerHTML = '';
  bmsDeviceCounter = 0;
  devices.forEach((dev, idx) => renderBmsDevice(dev, idx));
}
function renderBmsDevice(device, idx) {
  const container = document.getElementById('bms-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;
  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="bms_devices[${idx}][name]" placeholder="Device Name" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <label><input type="checkbox" name="bms_devices[${idx}][enabled]" ${device.enabled ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-bms">Remove</button>
    </div>
    <div class="form-row">
      <input type="text" name="bms_devices[${idx}][address]" placeholder="MAC Address (e.g., AA:BB:CC:DD:EE:FF)" value="${escapeHtml(device.address || '')}" style="flex:2;">
      <button type="button" class="fetch-btn scan-bms" data-device="${idx}">🔍 Scan</button>
      <button type="button" class="fetch-btn test-bms">Test Connection</button>
      <span class="test-status" id="bms-test-status-${idx}"></span>
    </div>
    <div class="note">MAC address can be found by scanning with a phone BLE scanner or using the bridge's /devices endpoint.</div>
  `;
  container.appendChild(card);
  card.querySelector('[data-action="remove-bms"]').addEventListener('click', () => {
    card.remove();
    reindexBms();
  });

  // Scan button – uses backend proxy to reach BMS bridge
  card.querySelector('.scan-bms').addEventListener('click', async () => {
    const statusEl = document.getElementById(`bms-test-status-${idx}`);
    showStatus(statusEl, 'Scanning for BLE devices...', 'info');
    try {
      const res = await fetch('/api/bms/scan', { timeout: 20000 });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showStatus(statusEl, err.error || 'Scan failed', 'error');
        return;
      }
      const devices = await res.json();
      if (!devices.length) {
        showStatus(statusEl, 'No BMS devices found', 'error');
        return;
      }
      const deviceList = devices.map(d => `${d.address} (${d.name || 'Unknown'}, RSSI: ${d.rssi})`).join('\n');
      const selected = prompt(`Select a device by entering its MAC address:\n${deviceList}`);
      if (selected && selected.trim()) {
        const macMatch = selected.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
        if (macMatch) {
          card.querySelector('input[name$="[address]"]').value = macMatch[0];
          showStatus(statusEl, `Selected ${macMatch[0]}`, 'success');
        } else {
          showStatus(statusEl, 'Invalid MAC address', 'error');
        }
      }
    } catch (err) {
      showStatus(statusEl, `Scan failed: ${err.message}`, 'error');
    }
  });

  // Test connection button – uses backend proxy to reach BMS bridge
  card.querySelector('.test-bms').addEventListener('click', async () => {
    const statusEl = document.getElementById(`bms-test-status-${idx}`);
    const address = card.querySelector('input[name$="[address]"]').value.trim();
    if (!address) {
      showStatus(statusEl, 'MAC address required', 'error');
      return;
    }
    showStatus(statusEl, 'Testing connection...', 'info');
    try {
      const res = await fetch(`/api/bms/test?address=${encodeURIComponent(address)}`, { timeout: 15000 });
      if (res.ok) {
        const data = await res.json();
        showStatus(statusEl, `OK - ${Object.keys(data).length} metrics`, 'success');
      } else {
        const err = await res.json().catch(() => ({}));
        showStatus(statusEl, err.error || `Error`, 'error');
      }
    } catch (err) {
      showStatus(statusEl, `Failed: ${err.message}`, 'error');
    }
  });

  bmsDeviceCounter++;
}
function reindexBms() {
  const cards = document.querySelectorAll('#bms-devices-container .device-card');
  bmsDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    bmsDeviceCounter++;
  });
}
const addBmsBtn = document.getElementById('add-bms-device');
if (addBmsBtn) addBmsBtn.addEventListener('click', () => {
  const idx = bmsDeviceCounter;
  renderBmsDevice({ name: '', address: '', enabled: true }, idx);
});

// ======================== FORECAST TEST ========================
const forecastTestBtn = document.getElementById('test-forecast');
if (forecastTestBtn) {
  forecastTestBtn.addEventListener('click', async function() {
    const btn = this;
    const statusEl = document.getElementById('forecast-test-status');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing...';
    showStatus(statusEl, 'Fetching forecast...', 'info');
    try {
      const res = await fetch('/api/test-forecast');
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `✅ ${data.source}: Today ~${data.today_estimate_kwh} kWh, Peak ${data.peak_kw} kW`, 'success');
      else showStatus(statusEl, `❌ ${data.error}`, 'error');
    } catch (e) {
      showStatus(statusEl, `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test Forecast';
    }
  });
}

// ======================== METRICS MANAGEMENT ========================
let metricsList = [];
async function loadMetricsList() {
  try {
    const res = await fetch('/api/metrics/list');
    if (!res.ok) throw new Error('Failed to fetch metrics');
    metricsList = await res.json();
    renderMetricsTable();
  } catch (err) {
    console.error('Error loading metrics:', err);
    const tbody = document.getElementById('metrics-table-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">Failed to load metrics</td></tr>';
  }
}
function renderMetricsTable() {
  const tbody = document.getElementById('metrics-table-body');
  if (!tbody) return;
  if (!metricsList.length) {
    tbody.innerHTML = '<tr><td colspan="5">No metrics yet. Create one using the "New Metric" button.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  metricsList.forEach(metric => {
    const row = document.createElement('tr');
    const lastUpdated = metric.timestamp ? new Date(metric.timestamp * 1000).toLocaleString() : 'Never';
    row.innerHTML = `
      <td>${escapeHtml(metric.name)}</td>
      <td>${metric.value !== null ? metric.value : '-'}</td>
      <td>${lastUpdated}</td>
      <td>${escapeHtml(metric.unit || '-')}</td>
      <td><button class="delete-metric-btn remove-btn" data-name="${escapeHtml(metric.name)}">Delete</button></td>
    `;
    tbody.appendChild(row);
  });
  document.querySelectorAll('.delete-metric-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const name = btn.dataset.name;
      if (confirm(`Delete metric "${name}"? This will remove it from all mappings and cannot be undone.`)) {
        try {
          const res = await fetch(`/api/metrics/${encodeURIComponent(name)}`, { method: 'DELETE' });
          if (res.ok) {
            showStatus(backupStatus, `Metric "${name}" deleted`, 'success');
            await loadMetricsList();
            await refreshAllMetricDropdowns();
          } else {
            const err = await res.json();
            showStatus(backupStatus, err.error || 'Delete failed', 'error');
          }
        } catch (err) {
          showStatus(backupStatus, err.message, 'error');
        }
      }
    });
  });
}
// Modal handling
const modal = document.getElementById('metric-modal');
const createBtn = document.getElementById('create-metric-btn');
const modalCancel = document.getElementById('modal-cancel');
const modalCreate = document.getElementById('modal-create');
if (createBtn) {
  createBtn.addEventListener('click', () => {
    if (modal) modal.style.display = 'flex';
    const nameInput = document.getElementById('new-metric-name');
    const unitInput = document.getElementById('new-metric-unit');
    if (nameInput) nameInput.value = '';
    if (unitInput) unitInput.value = '';
  });
}
if (modalCancel) modalCancel.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });
if (modalCreate) {
  modalCreate.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-metric-name');
    const unitInput = document.getElementById('new-metric-unit');
    const name = nameInput ? nameInput.value.trim() : '';
    const unit = unitInput ? unitInput.value.trim() : '';
    if (!name) { alert('Metric name is required'); return; }
    try {
      const res = await fetch('/api/metrics/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, unit }) });
      if (res.ok) {
        if (modal) modal.style.display = 'none';
        await loadMetricsList();
        await refreshAllMetricDropdowns();
        showStatus(backupStatus, `Metric "${name}" created`, 'success');
      } else {
        const err = await res.json();
        alert(err.error || 'Creation failed');
      }
    } catch (err) { alert(err.message); }
  });
}
window.addEventListener('click', (e) => { if (modal && e.target === modal) modal.style.display = 'none'; });

// ======================== DASHBOARD EDITOR ========================
let dashConfig = null;
function buildDashboardEditor(config) {
  dashConfig = config || { dashboards: [], activeDashboard: 'main' };
  const listEl = document.getElementById('dashboards-list');
  listEl.innerHTML = '';
  if (!dashConfig.dashboards.length) return;
  const activeId = dashConfig.activeDashboard || dashConfig.dashboards[0]?.id;
  dashConfig.dashboards.forEach(db => {
    const row = document.createElement('div');
    row.className = 'dash-row';
    row.innerHTML = `
      <input type="text" value="${escapeHtml(db.name)}" data-db-id="${db.id}" class="dash-name">
      <button type="button" class="fetch-btn set-active" data-id="${db.id}">${db.id === activeId ? '★ Active' : 'Set Active'}</button>
      <button type="button" class="remove-btn delete-dash" data-id="${db.id}">Del</button>
    `;
    listEl.appendChild(row);
    row.querySelector('.set-active').addEventListener('click', () => {
      dashConfig.activeDashboard = db.id;
      buildDashboardEditor(dashConfig);
    });
    row.querySelector('.delete-dash').addEventListener('click', () => {
      dashConfig.dashboards = dashConfig.dashboards.filter(d => d.id !== db.id);
      if (dashConfig.activeDashboard === db.id) dashConfig.activeDashboard = dashConfig.dashboards[0]?.id || 'main';
      buildDashboardEditor(dashConfig);
    });
    row.querySelector('.dash-name').addEventListener('change', (e) => { db.name = e.target.value; });
  });
  const activeDb = dashConfig.dashboards.find(db => db.id === activeId);
  if (activeDb) renderDashboardBlockEditor(activeDb);
}
function renderDashboardBlockEditor(dashboard) {
  const container = document.getElementById('active-dashboard-editor');
  container.innerHTML = `<h4>Editing: ${escapeHtml(dashboard.name)}</h4>`;
  const blockList = document.createElement('ul');
  blockList.className = 'block-list';
  dashboard.layout.forEach((block, idx) => {
    const li = document.createElement('li');
    li.dataset.index = idx;
    const currentSpan = block.colSpan ?? block.gridW ?? 12;
    const spanOpts = [
      [12, 'Full'], [9, '3/4'], [8, '2/3'], [6, '1/2'], [4, '1/3'], [3, '1/4']
    ];
    const spanOptions = spanOpts.map(([v, label]) =>
      `<option value="${v}" ${currentSpan == v ? 'selected' : ''}>${label}</option>`
    ).join('');
    li.innerHTML = `
      <select class="block-type-select">
        <option value="flow-card" ${block.type === 'flow-card' ? 'selected' : ''}>Flow Card</option>
        <option value="forecast-banner" ${block.type === 'forecast-banner' ? 'selected' : ''}>Forecast Banner</option>
        <option value="metric-cards" ${block.type === 'metric-cards' ? 'selected' : ''}>Metric Cards</option>
        <option value="grid-card" ${block.type === 'grid-card' ? 'selected' : ''}>Grid Card</option>
        <option value="chart-power" ${block.type === 'chart-power' ? 'selected' : ''}>Power Chart</option>
        <option value="chart-energy" ${block.type === 'chart-energy' ? 'selected' : ''}>Energy Chart</option>
        <option value="savings-summary" ${block.type === 'savings-summary' ? 'selected' : ''}>Savings Summary</option>
        <option value="data-table-daily" ${block.type === 'data-table-daily' ? 'selected' : ''}>Daily Table</option>
        <option value="data-table-monthly" ${block.type === 'data-table-monthly' ? 'selected' : ''}>Monthly Table</option>
        <option value="weather-block" ${block.type === 'weather-block' ? 'selected' : ''}>Weather Block</option>
        <option value="battery-block" ${block.type === 'battery-block' ? 'selected' : ''}>Battery Block</option>
      </select>
      <select class="block-width-select" style="width:80px;">
        ${spanOptions}
      </select>
      <select class="block-height-select" style="width:80px;">
        <option value="0" ${!block.rowSpan ? 'selected' : ''}>Auto</option>
        <option value="200" ${block.rowSpan == 200 ? 'selected' : ''}>200px</option>
        <option value="300" ${block.rowSpan == 300 ? 'selected' : ''}>300px</option>
        <option value="400" ${block.rowSpan == 400 ? 'selected' : ''}>400px</option>
        <option value="500" ${block.rowSpan == 500 ? 'selected' : ''}>500px</option>
        <option value="600" ${block.rowSpan == 600 ? 'selected' : ''}>600px</option>
        <option value="700" ${block.rowSpan == 700 ? 'selected' : ''}>700px</option>
      </select>
      <button type="button" class="remove-btn delete-block">Remove</button>
      <button type="button" class="fetch-btn config-block-btn" style="background:#4b5563;">⚙️ Config</button>
    `;
    if (block.type === 'metric-cards') {
      const cardEditorDiv = document.createElement('div');
      cardEditorDiv.className = 'metric-cards-editor';
      cardEditorDiv.style.marginTop = '0.5rem';
      cardEditorDiv.style.paddingLeft = '1rem';
      cardEditorDiv.style.borderLeft = '2px solid var(--accent)';
      const cardsList = document.createElement('div');
      cardsList.className = 'cards-list';
      function getMetricOptions(selectedMetric) {
        let options = '<option value="">-- Select metric --</option>';
        if (metricsList && metricsList.length) {
          metricsList.forEach(m => {
            options += `<option value="${escapeHtml(m.name)}" ${selectedMetric === m.name ? 'selected' : ''}>${escapeHtml(m.name)}${m.unit ? ` (${escapeHtml(m.unit)})` : ''}</option>`;
          });
        }
        options += '<option value="__CREATE_NEW__">+ Create new metric...</option>';
        return options;
      }
      function renderCards() {
        cardsList.innerHTML = '';
        (block.cards || []).forEach((card, cardIdx) => {
          const cardRow = document.createElement('div');
          cardRow.className = 'card-editor-row';
          cardRow.innerHTML = `
            <input type="text" class="card-title" value="${escapeHtml(card.title || '')}" placeholder="Title" style="flex:2;">
            <select class="card-metric-select" style="flex:2;">${getMetricOptions(card.metric || '')}</select>
            <input type="text" class="card-unit" value="${escapeHtml(card.unit || '')}" placeholder="Unit" style="flex:1;">
            <button type="button" class="remove-card-btn remove-btn" style="background:#ef4444;">−</button>
          `;
          const metricSelect = cardRow.querySelector('.card-metric-select');
          metricSelect.addEventListener('change', async (e) => {
            if (e.target.value === '__CREATE_NEW__') {
              e.target.value = card.metric || '';
              if (modal) {
                modal.style.display = 'flex';
                const originalCreateHandler = modalCreate.onclick;
                modalCreate.onclick = async () => {
                  const nameInput = document.getElementById('new-metric-name');
                  const unitInput = document.getElementById('new-metric-unit');
                  const name = nameInput ? nameInput.value.trim() : '';
                  const unit = unitInput ? unitInput.value.trim() : '';
                  if (!name) { alert('Metric name is required'); return; }
                  try {
                    const res = await fetch('/api/metrics/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, unit }) });
                    if (res.ok) {
                      if (modal) modal.style.display = 'none';
                      await loadMetricsList();
                      await refreshAllMetricDropdowns();
                      document.querySelectorAll('.card-metric-select').forEach(select => {
                        const currentVal = select.value;
                        select.innerHTML = getMetricOptions(currentVal);
                      });
                      showStatus(backupStatus, `Metric "${name}" created`, 'success');
                    } else {
                      const err = await res.json();
                      alert(err.error || 'Creation failed');
                    }
                  } catch (err) { alert(err.message); }
                  modalCreate.onclick = originalCreateHandler;
                };
              }
            } else {
              card.metric = e.target.value;
            }
          });
          const unitInput = cardRow.querySelector('.card-unit');
          unitInput.addEventListener('change', (e) => { card.unit = e.target.value; });
          const titleInput = cardRow.querySelector('.card-title');
          titleInput.addEventListener('change', (e) => { card.title = e.target.value; });
          cardRow.querySelector('.remove-card-btn').addEventListener('click', () => {
            block.cards.splice(cardIdx, 1);
            renderCards();
          });
          cardsList.appendChild(cardRow);
        });
      }
      renderCards();
      const addCardBtn = document.createElement('button');
      addCardBtn.textContent = '+ Add Card';
      addCardBtn.className = 'fetch-btn';
      addCardBtn.style.marginTop = '0.5rem';
      addCardBtn.addEventListener('click', () => {
        if (!block.cards) block.cards = [];
        block.cards.push({ id: 'card_' + Date.now() + '_' + Math.random(), title: 'New Card', metric: '', unit: '' });
        renderCards();
      });
      cardEditorDiv.appendChild(cardsList);
      cardEditorDiv.appendChild(addCardBtn);
      li.appendChild(cardEditorDiv);
    }
    const configBtn = li.querySelector('.config-block-btn');
    configBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existingPanel = li.querySelector('.block-config-panel');
      if (existingPanel) existingPanel.remove();
      const configPanel = document.createElement('div');
      configPanel.className = 'block-config-panel';
      configPanel.style.marginTop = '0.5rem';
      configPanel.style.padding = '0.5rem';
      configPanel.style.backgroundColor = 'var(--bg)';
      configPanel.style.borderRadius = '0.5rem';
      configPanel.style.border = '1px solid var(--border)';
      if (block.type === 'chart-power' || block.type === 'chart-energy') {
        let datasets = block.config?.datasets || [];
        if (datasets.length && typeof datasets[0] === 'string') {
          datasets = datasets.map(ds => ({ label: ds, metric: ds, color: '#888' }));
        }
        if (!datasets.length) {
          datasets = block.type === 'chart-power'
            ? [{ label: 'Load', metric: 'consumption', color: '#7c3aed' }, { label: 'Solar', metric: 'solar', color: '#d97706' }, { label: 'Battery Charge', metric: 'battery_charge', color: '#059669' }, { label: 'Grid Import', metric: 'grid_import', color: '#dc2626' }]
            : [{ label: 'Solar Generated', metric: 'daily_solar', color: '#d97706' }, { label: 'Grid Imported', metric: 'daily_grid_import', color: '#dc2626' }, { label: 'Energy Consumed', metric: 'daily_consumption', color: '#7c3aed' }];
        }
        const datasetRows = datasets.map((ds, idx) => `
          <div style="border:1px solid var(--border);padding:0.5rem;margin:0.5rem 0;border-radius:4px;">
            <label>Label</label>
            <input type="text" class="config-ds-label" data-idx="${idx}" value="${escapeHtml(ds.label || '')}" style="width:100%;margin-bottom:0.3rem;">
            <label>Metric</label>
            <select class="config-ds-metric" data-idx="${idx}" style="width:100%;margin-bottom:0.3rem;">${generateMetricOptionsHtml(ds.metric)}</select>
            <label>Color</label>
            <input type="color" class="config-ds-color" data-idx="${idx}" value="${escapeHtml(ds.color || '#888')}" style="width:100%;margin-bottom:0.3rem;">
            <button type="button" class="remove-ds-btn" data-idx="${idx}" style="width:100%;">Remove</button>
          </div>
        `).join('');
        configPanel.innerHTML = `
          <label>Chart Title</label>
          <input type="text" class="config-chart-title" value="${escapeHtml(block.config?.title || '')}" style="width:100%;margin-bottom:0.5rem;">
          <h4 style="margin:0.5rem 0;">Datasets</h4>
          ${datasetRows}
          <button type="button" class="add-ds-btn fetch-btn" style="width:100%;margin-top:0.5rem;">+ Add Dataset</button>
          <button class="fetch-btn save-config" style="margin-top:0.5rem;">Save</button>`;
      } else if (block.type === 'flow-card') {
        const currentMetrics = block.config?.metrics || {};
        const metricRoles = [
          { key: 'solar', label: 'Solar Power Metric' },
          { key: 'battery_soc', label: 'Battery SOC Metric' },
          { key: 'battery_charge', label: 'Battery Charge Power Metric' },
          { key: 'battery_discharge', label: 'Battery Discharge Power Metric' },
          { key: 'consumption', label: 'Consumption Metric' },
          { key: 'grid_import', label: 'Grid Import Power Metric' },
          { key: 'grid_export', label: 'Grid Export Power Metric' }
        ];
        const selectsHtml = metricRoles.map(role => `
          <label>${escapeHtml(role.label)}</label>
          <select class="config-metric" data-role="${role.key}" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics[role.key])}</select>
        `).join('');
        configPanel.innerHTML = `
          <label>Block Title</label>
          <input type="text" class="config-title" value="${escapeHtml(block.config?.title || 'Energy Flow')}" style="width:100%; margin-bottom:0.5rem;">
          <label><input type="checkbox" class="config-show-gauge" ${block.config?.showGauge !== false ? 'checked' : ''}> Show Solar Gauge</label>
          ${selectsHtml}
          <button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'grid-card') {
        const currentMetrics = block.config?.metrics || {};
        configPanel.innerHTML = `
          <label><input type="checkbox" class="config-show-timeline" ${block.config?.showTimeline !== false ? 'checked' : ''}> Show Timeline Bar</label>
          <label>Grid Status Metric (optional)</label>
          <select class="config-metric" data-role="grid_status" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.grid_status, 'Use global setting')}</select>
          <p style="font-size:0.8rem;color:var(--text-secondary);">Leave empty to use Home Assistant entity</p>
          <button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'weather-block') {
        configPanel.innerHTML = `<label>Title</label><input type="text" class="config-title" value="${escapeHtml(block.config?.title || 'Weather')}"><button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'battery-block') {
        const currentMetrics = block.config?.metrics || {};
        configPanel.innerHTML = `
          <label>Block Title</label>
          <input type="text" class="config-title" value="${escapeHtml(block.config?.title || 'Battery')}" style="width:100%; margin-bottom:0.5rem;">
          <label>SOC Metric</label>
          <select class="config-metric" data-role="soc" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.soc)}</select>
          <label>Voltage Metric</label>
          <select class="config-metric" data-role="voltage" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.voltage)}</select>
          <label>Current Metric</label>
          <select class="config-metric" data-role="current" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.current)}</select>
          <label>Power Metric</label>
          <select class="config-metric" data-role="power" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.power)}</select>
          <label>Temperature Metric</label>
          <select class="config-metric" data-role="temperature" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.temperature)}</select>
          <button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'savings-summary') {
        configPanel.innerHTML = `<label>Block Title</label><input type="text" class="config-title" value="${escapeHtml(block.config?.title || 'Savings Summary')}">
          <label><input type="checkbox" class="config-show-today" ${block.config?.showToday !== false ? 'checked' : ''}> Show Today</label>
          <label><input type="checkbox" class="config-show-week" ${block.config?.showWeek !== false ? 'checked' : ''}> Show Week</label>
          <label><input type="checkbox" class="config-show-month" ${block.config?.showMonth !== false ? 'checked' : ''}> Show Month</label>
          <label><input type="checkbox" class="config-show-all" ${block.config?.showAll !== false ? 'checked' : ''}> Show All-Time</label>
          <button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'data-table-daily' || block.type === 'data-table-monthly') {
        const columns = block.config?.columns || [
          { field: 'consumption_kwh', label: 'Load (kWh)' },
          { field: 'solar_kwh', label: 'Solar PV (kWh)' },
          { field: 'battery_charge_kwh', label: 'Battery charged (kWh)' },
          { field: 'battery_discharge_kwh', label: 'Battery discharged (kWh)' },
          { field: 'grid_import_kwh', label: 'Grid used (kWh)' },
          { field: 'grid_export_kwh', label: 'Grid exported (kWh)' }
        ];
        const fieldOptions = [
          { value: 'consumption_kwh', label: 'Load' },
          { value: 'solar_kwh', label: 'Solar PV' },
          { value: 'battery_charge_kwh', label: 'Battery charged' },
          { value: 'battery_discharge_kwh', label: 'Battery discharged' },
          { value: 'grid_import_kwh', label: 'Grid used' },
          { value: 'grid_export_kwh', label: 'Grid exported' }
        ];
        const fieldSelectHtml = fieldOptions.map(f =>
          `<option value="${f.value}">${f.label}</option>`
        ).join('');
        const colRows = columns.map((col, i) => `
          <div style="display:flex;gap:0.5rem;margin-bottom:0.4rem;align-items:center;">
            <input type="text" class="config-col-label" data-idx="${i}" value="${escapeHtml(col.label)}" style="flex:1;">
            <select class="config-col-field" data-idx="${i}" style="flex:1;">${fieldSelectHtml.replace(`value="${col.field}"`, `value="${col.field}" selected`)}</select>
            <button type="button" class="remove-col-btn" data-idx="${i}" style="padding:0.3rem 0.5rem;">✕</button>
          </div>
        `).join('');
        configPanel.innerHTML = `
          <label>Block Title</label>
          <input type="text" class="config-title" value="${escapeHtml(block.config?.title || '')}" style="width:100%; margin-bottom:0.5rem;">
          <h4 style="margin:0.5rem 0;">Columns</h4>
          ${colRows}
          <button type="button" class="add-col-btn fetch-btn" style="width:100%;margin-top:0.5rem;">+ Add Column</button>
          <button class="fetch-btn save-config" style="margin-top:0.5rem;">Save</button>`;
      } else if (block.type === 'forecast-banner') {
        const currentMetrics = block.config?.metrics || {};
        const fieldOptions = [
          { value: 'solar_kw', label: 'Solar Power (kW)' },
          { value: 'consumption_kw', label: 'Consumption (kW)' },
          { value: 'battery_charge_kw', label: 'Battery Charge (kW)' },
          { value: 'grid_import_kw', label: 'Grid Import (kW)' }
        ];
        const fieldSelectHtml = fieldOptions.map(f =>
          `<option value="${f.value}" ${currentMetrics.actual_energy === f.value ? 'selected' : ''}>${f.label}</option>`
        ).join('');
        configPanel.innerHTML = `
          <label>Actual Energy Metric for Sparkline</label>
          <select class="config-metric" data-role="actual_energy" style="width:100%; margin-bottom:0.5rem;">
            <option value="">-- Select --</option>
            ${fieldSelectHtml}
          </select>
          <p style="font-size:0.8rem;color:var(--text-secondary);">Which history field to show as the "Actual" line in the sparkline. Default: Solar PV.</p>
          <button class="fetch-btn save-config">Save</button>`;
      } else {
        configPanel.innerHTML = '<div class="note">No configurable options.</div>';
      }
      const saveBtn = configPanel.querySelector('.save-config');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          if (!block.config) block.config = {};
          if (block.type === 'chart-power' || block.type === 'chart-energy') {
            block.config.title = configPanel.querySelector('.config-chart-title')?.value || '';
            block.config.datasets = [];
            configPanel.querySelectorAll('.config-ds-label').forEach(labelEl => {
              const idx = parseInt(labelEl.dataset.idx);
              const metricEl = configPanel.querySelector(`.config-ds-metric[data-idx="${idx}"]`);
              const colorEl = configPanel.querySelector(`.config-ds-color[data-idx="${idx}"]`);
              if (labelEl && metricEl && colorEl) {
                block.config.datasets.push({
                  label: labelEl.value,
                  metric: metricEl.value,
                  color: colorEl.value
                });
              }
            });
          } else if (block.type === 'battery-block') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
            block.config.metrics = {};
            configPanel.querySelectorAll('.config-metric').forEach(select => {
              const role = select.dataset.role;
              if (select.value) block.config.metrics[role] = select.value;
            });
          } else if (block.type === 'flow-card') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
            const gauge = configPanel.querySelector('.config-show-gauge');
            block.config.showGauge = gauge ? gauge.checked : true;
            block.config.metrics = {};
            configPanel.querySelectorAll('.config-metric').forEach(select => {
              const role = select.dataset.role;
              if (select.value) block.config.metrics[role] = select.value;
            });
          } else if (block.type === 'grid-card') {
            const timeline = configPanel.querySelector('.config-show-timeline');
            block.config.showTimeline = timeline ? timeline.checked : true;
            block.config.metrics = {};
            configPanel.querySelectorAll('.config-metric').forEach(select => {
              const role = select.dataset.role;
              if (select.value) block.config.metrics[role] = select.value;
            });
          } else if (block.type === 'data-table-daily' || block.type === 'data-table-monthly') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
            block.config.columns = [];
            configPanel.querySelectorAll('.config-col-label').forEach(labelEl => {
              const idx = parseInt(labelEl.dataset.idx);
              const fieldEl = configPanel.querySelector(`.config-col-field[data-idx="${idx}"]`);
              if (labelEl && fieldEl && fieldEl.value) {
                block.config.columns.push({ label: labelEl.value, field: fieldEl.value });
              }
            });
          } else if (block.type === 'forecast-banner') {
            block.config.metrics = {};
            configPanel.querySelectorAll('.config-metric').forEach(select => {
              const role = select.dataset.role;
              if (select.value) block.config.metrics[role] = select.value;
            });
          } else if (block.type === 'weather-block') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
          } else if (block.type === 'savings-summary') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
            block.config.showToday = configPanel.querySelector('.config-show-today')?.checked ?? true;
            block.config.showWeek = configPanel.querySelector('.config-show-week')?.checked ?? true;
            block.config.showMonth = configPanel.querySelector('.config-show-month')?.checked ?? true;
            block.config.showAll = configPanel.querySelector('.config-show-all')?.checked ?? true;
          }
          configPanel.remove();
        });
      }
      // Attach add/remove dataset handlers for chart config panels
      if (block.type === 'chart-power' || block.type === 'chart-energy') {
        const addBtn = configPanel.querySelector('.add-ds-btn');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            const existingRows = configPanel.querySelectorAll('.config-ds-label');
            const newIdx = existingRows.length;
            const newRow = document.createElement('div');
            newRow.style.cssText = 'border:1px solid var(--border);padding:0.5rem;margin:0.5rem 0;border-radius:4px;';
            newRow.innerHTML = `
              <label>Label</label>
              <input type="text" class="config-ds-label" data-idx="${newIdx}" value="New Dataset" style="width:100%;margin-bottom:0.3rem;">
              <label>Metric</label>
              <select class="config-ds-metric" data-idx="${newIdx}" style="width:100%;margin-bottom:0.3rem;">${generateMetricOptionsHtml('')}</select>
              <label>Color</label>
              <input type="color" class="config-ds-color" data-idx="${newIdx}" value="#888888" style="width:100%;margin-bottom:0.3rem;">
              <button type="button" class="remove-ds-btn" data-idx="${newIdx}" style="width:100%;">Remove</button>
            `;
            newRow.querySelector('.remove-ds-btn').addEventListener('click', () => newRow.remove());
            addBtn.before(newRow);
          });
        }
        configPanel.querySelectorAll('.remove-ds-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            btn.closest('div').remove();
          });
        });
      }
      // Attach add/remove column handlers for table config panels
      if (block.type === 'data-table-daily' || block.type === 'data-table-monthly') {
        const addBtn = configPanel.querySelector('.add-col-btn');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            const existingRows = configPanel.querySelectorAll('.config-col-label');
            const newIdx = existingRows.length;
            const fieldOptions = [
              { value: 'consumption_kwh', label: 'Load' },
              { value: 'solar_kwh', label: 'Solar PV' },
              { value: 'battery_charge_kwh', label: 'Battery charged' },
              { value: 'battery_discharge_kwh', label: 'Battery discharged' },
              { value: 'grid_import_kwh', label: 'Grid used' },
              { value: 'grid_export_kwh', label: 'Grid exported' }
            ];
            const fieldSelectHtml = fieldOptions.map(f =>
              `<option value="${f.value}">${f.label}</option>`
            ).join('');
            const newRow = document.createElement('div');
            newRow.style.cssText = 'display:flex;gap:0.5rem;margin-bottom:0.4rem;align-items:center;';
            newRow.innerHTML = `
              <input type="text" class="config-col-label" data-idx="${newIdx}" value="New Column" style="flex:1;">
              <select class="config-col-field" data-idx="${newIdx}" style="flex:1;">${fieldSelectHtml}</select>
              <button type="button" class="remove-col-btn" data-idx="${newIdx}" style="padding:0.3rem 0.5rem;">✕</button>
            `;
            newRow.querySelector('.remove-col-btn').addEventListener('click', () => newRow.remove());
            addBtn.before(newRow);
          });
        }
        configPanel.querySelectorAll('.remove-col-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            btn.closest('div').remove();
          });
        });
      }
      li.appendChild(configPanel);
    });
    li.querySelector('.block-type-select').addEventListener('change', (e) => {
      const newType = e.target.value;
      dashboard.layout[idx].type = newType;
      if (newType === 'metric-cards' && !dashboard.layout[idx].cards) dashboard.layout[idx].cards = [];
      renderDashboardBlockEditor(dashboard);
    });
    li.querySelector('.block-width-select').addEventListener('change', (e) => {
      dashboard.layout[idx].colSpan = parseInt(e.target.value);
    });
    li.querySelector('.block-height-select').addEventListener('change', (e) => {
      dashboard.layout[idx].rowSpan = parseInt(e.target.value) || 0;
    });
    li.querySelector('.delete-block').addEventListener('click', () => {
      dashboard.layout.splice(idx, 1);
      renderDashboardBlockEditor(dashboard);
    });
    blockList.appendChild(li);
  });
  container.appendChild(blockList);
  const addBlockBtn = document.createElement('button');
  addBlockBtn.textContent = '+ Add Block';
  addBlockBtn.className = 'fetch-btn';
  addBlockBtn.addEventListener('click', () => {
    dashboard.layout.push({ type: 'flow-card' });
    renderDashboardBlockEditor(dashboard);
  });
  container.appendChild(addBlockBtn);
}
const addDashboardBtn = document.getElementById('add-dashboard-btn');
if (addDashboardBtn) addDashboardBtn.addEventListener('click', () => {
  const newId = 'db_' + Date.now();
  dashConfig.dashboards.push({ id: newId, name: 'New Tab', layout: [] });
  dashConfig.activeDashboard = newId;
  buildDashboardEditor(dashConfig);
});

// ======================== LAYOUT IMPORT/EXPORT ========================
const exportLayoutBtn = document.getElementById('export-layout-btn');
if (exportLayoutBtn) exportLayoutBtn.addEventListener('click', () => window.location.href = '/api/dashboard-config/export');
const importLayoutBtn = document.getElementById('import-layout-btn');
const importLayoutFile = document.getElementById('import-layout-file');
if (importLayoutBtn && importLayoutFile) {
  importLayoutBtn.addEventListener('click', () => importLayoutFile.click());
  importLayoutFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('layout', file);
    try {
      const res = await fetch('/api/dashboard-config/import', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        showStatus(backupStatus, 'Layout imported successfully! Reloading...', 'success');
        setTimeout(() => location.reload(), 1500);
      } else {
        showStatus(backupStatus, data.error || 'Import failed', 'error');
      }
    } catch (err) {
      showStatus(backupStatus, 'Error: ' + err.message, 'error');
    } finally {
      importLayoutFile.value = '';
    }
  });
}

// ======================== SAVE ========================
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {};
  form.querySelectorAll('input[name], select[name], textarea[name]').forEach(el => {
    if (el.name.startsWith('ha_devices[') || el.name.startsWith('mqtt_devices[') || el.name.startsWith('modbus_devices[') || el.name === 'dashboard_config' || el.name.startsWith('external_sources[') || el.name.startsWith('bms_devices[')) return;
    if (el.type === 'checkbox') payload[el.name] = el.checked ? 'true' : 'false';
    else payload[el.name] = el.value;
  });
  payload.ha_devices = collectDeviceArray('ha-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.url = card.querySelector('input[name$="[url]"]').value;
    dev.token = card.querySelector('input[name$="[token]"]').value;
    dev.poll_interval = card.querySelector('input[name$="[poll_interval]"]').value;
    dev.entities = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const metricName = row.querySelector('.metric-name').value; // from dropdown
      const entityId = row.querySelector('.entity-select').value;
      if (metricName && entityId) dev.entities[metricName] = entityId;
    });
    return dev;
  });
  payload.mqtt_devices = collectDeviceArray('mqtt-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.broker = card.querySelector('input[name$="[broker]"]').value;
    dev.username = card.querySelector('input[name$="[username]"]')?.value || '';
    dev.password = card.querySelector('input[name$="[password]"]')?.value || '';
    dev.topics = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const metricName = row.querySelector('.metric-name').value;
      const topic = row.querySelector('.topic-input').value.trim();
      if (metricName && topic) dev.topics[metricName] = topic;
    });
    return dev;
  });
  payload.modbus_devices = collectDeviceArray('modbus-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.transport = card.querySelector('.modbus-transport-select').value;
    dev.profile = card.querySelector('.modbus-profile-select').value;
    dev.host = card.querySelector('input[name$="[host]"]')?.value || '';
    dev.port = card.querySelector('input[name$="[port]"]')?.value || '';
    dev.serial_path = card.querySelector('input[name$="[serial_path]"]')?.value || '';
    dev.serial_baud = card.querySelector('input[name$="[serial_baud]"]')?.value || '';
    dev.serial_data_bits = card.querySelector('input[name$="[serial_data_bits]"]')?.value || '';
    dev.serial_parity = card.querySelector('select[name$="[serial_parity]"]')?.value || '';
    dev.serial_stop_bits = card.querySelector('input[name$="[serial_stop_bits]"]')?.value || '';
    dev.unit = card.querySelector('input[name$="[unit]"]')?.value || 1;
    dev.poll_interval = card.querySelector('input[name$="[poll_interval]"]')?.value || 30;
    return dev;
  });
  payload.external_sources = collectDeviceArray('external-sources-container', (card) => {
    const src = {};
    src.name = card.querySelector('.device-header input[type="text"]').value;
    src.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    src.url = card.querySelector('input[name$="[url]"]').value;
    src.mappings = {};
    card.querySelectorAll('.mappings-list .metric-row').forEach(row => {
      const jsonPath = row.querySelector('.jsonpath').value.trim();
      const metricName = row.querySelector('.metric-name').value;
      if (jsonPath && metricName) src.mappings[jsonPath] = metricName;
    });
    return src;
  });
  payload.bms_devices = collectDeviceArray('bms-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.address = card.querySelector('input[name$="[address]"]').value;
    return dev;
  });
  payload.dashboard_config = JSON.stringify(dashConfig);
  try {
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) showStatus(saveStatus, 'Settings saved successfully!', 'success');
    else { const err = await res.json().catch(() => ({})); showStatus(saveStatus, err.error || 'Failed to save', 'error'); }
  } catch (e) { showStatus(saveStatus, 'Error: ' + e.message, 'error'); }
});

function collectDeviceArray(containerId, extractFn) {
  const container = document.getElementById(containerId);
  if (!container) return '[]';
  const cards = container.querySelectorAll('.device-card');
  const arr = [];
  cards.forEach(card => arr.push(extractFn(card)));
  return JSON.stringify(arr);
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Initialize
loadMetricsList();
loadSettings();
