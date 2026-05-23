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
      if (key.startsWith('ha_devices') || key.startsWith('mqtt_devices') || key.startsWith('modbus_devices') || key === 'dashboard_config' || key === 'external_sources' || key === 'bms_devices' || key === 'dongle_config' || key === 'pvoutput_config' || key === 'pvoutput_stats_cache' || key === 'pvoutput_rate_limit_state') continue;
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
    buildDongleDeviceList(JSON.parse(data.dongle_config || '[]'));
    buildPvoutputConfig(data.pvoutput_config ? JSON.parse(data.pvoutput_config) : {});
    const dashConfig = data.dashboard_config ? JSON.parse(data.dashboard_config) : null;
    buildDashboardEditor(dashConfig);
    populateDashboardSelects(dashConfig);

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

// ======================== INVERTER DONGLE ========================
let dongleDeviceCounter = 0;
let dongleProfilesCache = [];

function buildDongleDeviceList(devices) {
  const container = document.getElementById('dongle-devices-container');
  if (!container) return;
  container.innerHTML = '';
  dongleDeviceCounter = 0;
  // Preload profiles once
  fetch('/api/dongle/profiles').then(r => r.json()).then(p => { dongleProfilesCache = p; }).catch(() => {});
  devices.forEach((dev, idx) => renderDongleDevice(dev, idx));
}

function getProfileById(id) {
  return dongleProfilesCache.find(p => p.id === id);
}

function getTransportForProfile(profileId) {
  const p = getProfileById(profileId);
  return p ? p.transport : 'solarman-v5';
}

function renderDongleDevice(device, idx) {
  const container = document.getElementById('dongle-devices-container');
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.index = idx;

  const transport = device.profile ? getTransportForProfile(device.profile) : (device.transport || 'solarman-v5');

  card.innerHTML = `
    <div class="device-header">
      <input type="text" name="dongle_config[${idx}][name]" placeholder="Instance Name (e.g., SRNE Inverter)" value="${escapeHtml(device.name || '')}" style="flex:1;">
      <label><input type="checkbox" name="dongle_config[${idx}][enabled]" ${device.enabled !== false ? 'checked' : ''}> Enabled</label>
      <button type="button" class="remove-btn" data-action="remove-dongle">Remove</button>
    </div>
    <div class="form-row">
      <select name="dongle_config[${idx}][profile]" class="dongle-profile-select">
        <option value="">-- Select profile --</option>
      </select>
      <input type="text" name="dongle_config[${idx}][host]" placeholder="Host / IP Address" value="${escapeHtml(device.host || '')}">
      <input type="number" name="dongle_config[${idx}][port]" placeholder="Port" value="${device.port || ''}">
    </div>
    <div class="form-row dongle-serial-row" style="${transport === 'modbus-tcp' ? 'display:none;' : ''}">
      <input type="text" name="dongle_config[${idx}][serial_number]" placeholder="Logger Serial Number" value="${escapeHtml(device.serial_number || '')}">
    </div>
    <div class="form-row">
      <input type="number" name="dongle_config[${idx}][modbus_unit_id]" placeholder="Modbus Unit ID" value="${device.modbus_unit_id || 1}" style="width:100px;">
      <input type="number" name="dongle_config[${idx}][poll_interval]" placeholder="Poll (s)" value="${device.poll_interval || 30}" style="width:100px;">
      <input type="text" name="dongle_config[${idx}][prefix]" placeholder="Metric Prefix (optional)" value="${escapeHtml(device.prefix || '')}" style="width:150px;">
      <button type="button" class="fetch-btn test-dongle">Test Connection</button>
      <span class="test-status" id="dongle-test-status-${idx}"></span>
    </div>
    <input type="hidden" name="dongle_config[${idx}][transport]" value="${transport}">
  `;
  container.appendChild(card);

  const serialRow = card.querySelector('.dongle-serial-row');
  const transportHidden = card.querySelector('input[name$="[transport]"]');

  const profileSelect = card.querySelector('.dongle-profile-select');
  (dongleProfilesCache.length ? Promise.resolve(dongleProfilesCache) : fetch('/api/dongle/profiles').then(r => r.json()))
    .then(profiles => {
      if (!dongleProfilesCache.length) dongleProfilesCache = profiles;
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === device.profile) opt.selected = true;
        profileSelect.appendChild(opt);
      });
    }).catch(() => {});

  profileSelect.addEventListener('change', () => {
    const p = getProfileById(profileSelect.value);
    if (!p) return;
    transportHidden.value = p.transport;
    serialRow.style.display = p.transport === 'modbus-tcp' ? 'none' : '';
    const portInput = card.querySelector('input[name$="[port]"]');
    portInput.value = p.default_port || '';
    card.querySelector('input[name$="[modbus_unit_id]"]').value = p.default_unit_id || 1;
  });

  card.querySelector('[data-action="remove-dongle"]').addEventListener('click', () => {
    card.remove();
    reindexDongle();
  });

  card.querySelector('.test-dongle').addEventListener('click', async () => {
    const statusEl = document.getElementById(`dongle-test-status-${idx}`);
    const host = card.querySelector('input[name$="[host]"]').value.trim();
    const port = card.querySelector('input[name$="[port]"]').value;
    const serial = card.querySelector('input[name$="[serial_number]"]')?.value || '';
    const unitId = card.querySelector('input[name$="[modbus_unit_id]"]').value;
    const tx = transportHidden.value;
    if (!host) { showStatus(statusEl, 'Host required', 'error'); return; }
    showStatus(statusEl, 'Testing...', 'info');
    try {
      const res = await fetch('/api/dongle/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port: parseInt(port) || undefined, serial_number: serial, modbus_unit_id: parseInt(unitId) || 1, transport: tx })
      });
      const data = await res.json();
      if (res.ok) showStatus(statusEl, `OK — Register 0x0100 = ${data.raw}`, 'success');
      else showStatus(statusEl, data.error, 'error');
    } catch (err) {
      showStatus(statusEl, err.message, 'error');
    }
  });

  dongleDeviceCounter++;
}
function reindexDongle() {
  const cards = document.querySelectorAll('#dongle-devices-container .device-card');
  dongleDeviceCounter = 0;
  cards.forEach((card, i) => {
    card.dataset.index = i;
    dongleDeviceCounter++;
  });
}
const addDongleBtn = document.getElementById('add-dongle-device');
if (addDongleBtn) addDongleBtn.addEventListener('click', () => {
  const idx = dongleDeviceCounter;
  renderDongleDevice({ name: '', host: '', port: '', serial_number: '', modbus_unit_id: 1, poll_interval: 30, transport: 'solarman-v5', profile: '', prefix: '', enabled: true }, idx);
});

// ======================== PVOUTPUT ========================
function buildPvoutputConfig(config) {
  if (!config) config = {};
  const enabledCb = document.getElementById('pvoutput-enabled');
  if (enabledCb) enabledCb.checked = config.enabled === true;
  const apiKey = document.getElementById('pvoutput-api-key');
  if (apiKey) apiKey.value = config.api_key || '';
  const sysId = document.getElementById('pvoutput-system-id');
  if (sysId) sysId.value = config.system_id || '';
  const tz = document.getElementById('pvoutput-timezone');
  if (tz) tz.value = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const interval = document.getElementById('pvoutput-interval');
  if (interval) interval.value = config.upload_interval_minutes || 5;
  const sysSize = document.getElementById('pvoutput-system-size');
  if (sysSize) sysSize.value = config.system_size_w || '';
  const webhookUrl = document.getElementById('pvoutput-webhook-url');
  if (webhookUrl) webhookUrl.value = config.webhook_url || '';

  const cumulativeRadio = document.querySelector('input[name="pvoutput-mode"][value="cumulative"]');
  const netRadio = document.querySelector('input[name="pvoutput-mode"][value="net"]');
  if (cumulativeRadio) cumulativeRadio.checked = !config.net_mode;
  if (netRadio) netRadio.checked = config.net_mode === true;

  // Metric mapping dropdowns
  const mm = config.metric_map || {};
  const metricFields = [
    { key: 'v1', label: 'v1 Energy Generated (Wh)', hint: 'Cumulative daily solar generation. Typically daily_solar_kwh or solar_kwh.' },
    { key: 'v2', label: 'v2 Power Generated (W)', hint: 'Instantaneous solar output in watts. Typically solar_power or solar.' },
    { key: 'v3', label: 'v3 Energy Consumed (Wh)', hint: 'Cumulative daily consumption. Typically daily_consumption or load_kwh.' },
    { key: 'v4', label: 'v4 Power Consumed (W)', hint: 'Instantaneous load in watts. Typically load_power or consumption.' },
    { key: 'v5', label: 'v5 Temperature (°C)', hint: 'Ambient or inverter temperature. Typically inverter_temperature.' },
    { key: 'v6', label: 'v6 Voltage (V)', hint: 'Grid/mains voltage. Typically grid_voltage.' }
  ];
  const container = document.getElementById('pvoutput-metrics-container');
  if (container) {
    container.innerHTML = metricFields.map(f => {
      const sel = generateMetricOptionsHtml(mm[f.key]);
      return `<div class="form-group" style="flex:1;min-width:200px;"><label>${escapeHtml(f.label)}</label><select class="pvoutput-metric" data-key="${f.key}" style="width:100%;">${sel}</select><div class="note">${escapeHtml(f.hint)}</div></div>`;
    }).join('');
  }

  // Queue status
  refreshPvoutputQueue();
}

function collectPvoutputConfig() {
  const mm = {};
  document.querySelectorAll('.pvoutput-metric').forEach(sel => {
    if (sel.value) mm[sel.dataset.key] = sel.value;
  });
  return {
    enabled: document.getElementById('pvoutput-enabled')?.checked || false,
    api_key: document.getElementById('pvoutput-api-key')?.value || '',
    system_id: document.getElementById('pvoutput-system-id')?.value || '',
    timezone: document.getElementById('pvoutput-timezone')?.value || '',
    upload_interval_minutes: parseInt(document.getElementById('pvoutput-interval')?.value) || 5,
    system_size_w: parseInt(document.getElementById('pvoutput-system-size')?.value) || 0,
    net_mode: document.querySelector('input[name="pvoutput-mode"]:checked')?.value === 'net',
    webhook_url: document.getElementById('pvoutput-webhook-url')?.value || '',
    metric_map: mm
  };
}

async function refreshPvoutputQueue() {
  const statusEl = document.getElementById('pvoutput-queue-status');
  if (!statusEl) return;
  try {
    const res = await fetch('/api/pvoutput/queue');
    if (!res.ok) { statusEl.textContent = 'Configure PVOutput first'; return; }
    const data = await res.json();
    if (data.pending > 0) {
      statusEl.innerHTML = `Pending: <strong>${data.pending}</strong> records across ${data.byDate?.length || 0} dates.`;
      if (data.pending > 100) {
        statusEl.innerHTML += `<br><span class="note" style="color:#dc2626;">Large queue detected. Free account backfill may take several hours. Consider enabling donation mode for batch upload support.</span>`;
      }
    } else {
      statusEl.textContent = 'Queue empty.';
    }
  } catch (e) { statusEl.textContent = ''; }
}

// Test connection button
const pvoutputTestBtn = document.getElementById('pvoutput-test-btn');
if (pvoutputTestBtn) {
  pvoutputTestBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('pvoutput-test-status');
    const apiKey = document.getElementById('pvoutput-api-key')?.value.trim();
    const sysId = document.getElementById('pvoutput-system-id')?.value.trim();
    if (!apiKey || !sysId) { showStatus(statusEl, 'API key and System ID required', 'error'); return; }
    showStatus(statusEl, 'Connecting to PVOutput...', 'info');
    try {
      const res = await fetch('/api/pvoutput/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, system_id: sysId })
      });
      const data = await res.json();
      if (res.ok) {
        showStatus(statusEl, `Connected — ${data.system_name}, ${data.system_size}W. Timezone: ${data.timezone}`, 'success');
        // Auto-fill timezone (NM6)
        if (data.timezone) {
          const tzInput = document.getElementById('pvoutput-timezone');
          if (tzInput && !tzInput.value) tzInput.value = data.timezone;
        }
      } else {
        showStatus(statusEl, data.error, 'error');
      }
    } catch (e) { showStatus(statusEl, e.message, 'error'); }
  });
}

// Backfill button
const backfillBtn = document.getElementById('pvoutput-backfill-btn');
if (backfillBtn) {
  backfillBtn.addEventListener('click', async () => {
    backfillBtn.disabled = true;
    backfillBtn.textContent = 'Running...';
    try {
      const res = await fetch('/api/pvoutput/backfill', { method: 'POST' });
      const data = await res.json();
      showStatus(document.getElementById('pvoutput-test-status'), data.message || 'Backfill complete', 'success');
      refreshPvoutputQueue();
    } catch (e) {
      showStatus(document.getElementById('pvoutput-test-status'), e.message, 'error');
    } finally {
      backfillBtn.disabled = false;
      backfillBtn.textContent = 'Run Backfill';
    }
  });
}

// View Queue button
const viewQueueBtn = document.getElementById('pvoutput-view-queue-btn');
if (viewQueueBtn) {
  viewQueueBtn.addEventListener('click', () => {
    refreshPvoutputQueue();
  });
}

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

function populateDashboardSelects(config) {
  const dashboards = config?.dashboards || [];
  [('desktop-dashboard'), ('mobile-dashboard')].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- Default --</option>';
    dashboards.forEach(db => { const o = document.createElement('option'); o.value = db.id; o.textContent = db.name; if (db.id === cur) o.selected = true; sel.appendChild(o); });
  });
}

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
    const ctl = (inner, label) => `<div style="display:flex;flex-direction:column;align-items:center;gap:0.1rem;"><div>${inner}</div><span style="font-size:0.6rem;color:var(--text-secondary);white-space:nowrap;">${label}</span></div>`;
    li.innerHTML = `
      ${ctl(`<select class="block-type-select">
        <option value="flow-card" ${block.type==='flow-card'?'selected':''}>Flow Card</option>
        <option value="forecast-banner" ${block.type==='forecast-banner'?'selected':''}>Forecast</option>
        <option value="forecast-sparkline" ${block.type==='forecast-sparkline'?'selected':''}>Sparkline</option>
        <option value="forecast-info" ${block.type==='forecast-info'?'selected':''}>Forecast Info</option>
        <option value="metric-cards" ${block.type==='metric-cards'?'selected':''}>Metrics</option>
        <option value="grid-card" ${block.type==='grid-card'?'selected':''}>Grid Card</option>
        <option value="chart-power" ${block.type==='chart-power'?'selected':''}>Power Chart</option>
        <option value="chart-energy" ${block.type==='chart-energy'?'selected':''}>Energy Chart</option>
        <option value="savings-summary" ${block.type==='savings-summary'?'selected':''}>Savings</option>
        <option value="data-table-daily" ${block.type==='data-table-daily'?'selected':''}>Daily Table</option>
        <option value="data-table-monthly" ${block.type==='data-table-monthly'?'selected':''}>Monthly Table</option>
        <option value="flow-card-2" ${block.type==='flow-card-2'?'selected':''}>Flow Card 2</option>
        <option value="multi-value" ${block.type==='multi-value'?'selected':''}>Multi-Value</option>
        <option value="gauge-card" ${block.type==='gauge-card'?'selected':''}>Gauge</option>
        <option value="half-gauge" ${block.type==='half-gauge'?'selected':''}>Half Gauge</option>
        <option value="half-gauge-2" ${block.type==='half-gauge-2'?'selected':''}>Half Gauge 2</option>
        <option value="flow-card-square" ${block.type==='flow-card-square'?'selected':''}>Flow Card Sq</option>
        <option value="flow-card-square-2" ${block.type==='flow-card-square-2'?'selected':''}>Flow Card Sq 2</option>
        <option value="text-card" ${block.type==='text-card'?'selected':''}>Text</option>
        <option value="iframe-card" ${block.type==='iframe-card'?'selected':''}>Embed</option>
        <option value="forecast-pvtoday" ${block.type==='forecast-pvtoday'?'selected':''}>PV Today</option>
      </select>`, 'Type')}
      ${ctl(`<select class="block-width-select" style="width:65px;">${spanOptions}</select>`, 'Width')}
      ${ctl(`<select class="block-height-select" style="width:65px;">
        <option value="0" ${!block.rowSpan?'selected':''}>Auto</option>
        <option value="100" ${block.rowSpan==100?'selected':''}>100</option>
        <option value="200" ${block.rowSpan==200?'selected':''}>200</option>
        <option value="300" ${block.rowSpan==300?'selected':''}>300</option>
        <option value="400" ${block.rowSpan==400?'selected':''}>400</option>
        <option value="500" ${block.rowSpan==500?'selected':''}>500</option>
        <option value="600" ${block.rowSpan==600?'selected':''}>600</option>
        <option value="700" ${block.rowSpan==700?'selected':''}>700</option>
      </select>`, 'Height')}
      ${ctl(`<input type="color" class="block-font-color" value="${escapeHtml(block.fontColor||'#0f172a')}" style="width:28px;height:28px;padding:0;border:none;cursor:pointer;">`, 'Font')}
      ${ctl(`<select class="block-font-size" style="width:55px;">
        <option value="" ${!block.fontSize?'selected':''}>-</option>
        <option value="0.75rem" ${block.fontSize==='0.75rem'?'selected':''}>XS</option>
        <option value="0.85rem" ${block.fontSize==='0.85rem'?'selected':''}>S</option>
        <option value="1rem" ${block.fontSize==='1rem'?'selected':''}>M</option>
        <option value="1.25rem" ${block.fontSize==='1.25rem'?'selected':''}>L</option>
        <option value="1.5rem" ${block.fontSize==='1.5rem'?'selected':''}>XL</option>
      </select>`, 'Size')}
      ${ctl(`<input type="color" class="block-bg-color" value="${escapeHtml(block.bgColor||'#ffffff')}" style="width:28px;height:28px;padding:0;border:none;cursor:pointer;">`, 'BG')}
      ${ctl(`<label class="block-transparent-label" title="Transparent"><input type="checkbox" class="block-transparent" ${block.transparent?'checked':''}> T</label>`, 'Glass')}
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
            ? [{ label: 'Load', metric: 'consumption', color: '#0062FF' }, { label: 'Solar', metric: 'solar', color: '#FFEA00' }, { label: 'Battery Charge', metric: 'battery_charge', color: '#00E056' }, { label: 'Grid Import', metric: 'grid_import', color: '#FF4255' }]
            : [{ label: 'Solar Generated', metric: 'daily_solar', color: '#FFEA00' }, { label: 'Grid Imported', metric: 'daily_grid_import', color: '#FF4255' }, { label: 'Energy Consumed', metric: 'daily_consumption', color: '#0062FF' }];
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
          <label>Grid Status Metric</label>
          <select class="config-metric" data-role="grid_status" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.grid_status, 'Use backend default')}</select>
          <button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'weather-block') {
        configPanel.innerHTML = '<div class="note">Removed.</div>';
      } else if (block.type === 'battery-block') {
        configPanel.innerHTML = '<div class="note">Removed.</div>';
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
      } else if (block.type === 'flow-card-2') {
        const currentMetrics = block.config?.metrics || {};
        const metricRoles = [
          { key: 'solar', label: 'Solar Power Metric' },
          { key: 'grid', label: 'Grid Import Metric' },
          { key: 'consumption', label: 'Consumption Metric' },
          { key: 'battery_power', label: 'Battery Power Metric' },
          { key: 'battery_soc', label: 'Battery SOC Metric' }
        ];
        const selectsHtml = metricRoles.map(role => `
          <label>${escapeHtml(role.label)}</label>
          <select class="config-metric" data-role="${role.key}" style="width:100%; margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics[role.key])}</select>
        `).join('');
        configPanel.innerHTML = `
          <label>Block Title</label>
          <input type="text" class="config-title" value="${escapeHtml(block.config?.title || '')}" style="width:100%; margin-bottom:0.5rem;">
          <label>Inverter Image URL</label>
          <input type="text" class="config-inverter-image" value="${escapeHtml(block.config?.inverter_image || '')}" placeholder="https://..." style="width:100%; margin-bottom:0.5rem;">
          ${selectsHtml}
          <button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'forecast-sparkline') {
        const currentMetrics = block.config?.metrics || {};
        configPanel.innerHTML = `<label>Actual Energy Field</label><select class="config-metric" data-role="actual_energy" style="width:100%;margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.actual_energy)}</select><button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'forecast-info') {
        configPanel.innerHTML = '<div class="note">No configurable options.</div>';
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
      } else if (block.type === 'multi-value') {
        const metrics = block.config?.metrics || [{ label: '', metric: '', unit: '' }];
        const rows = metrics.map((m, i) => `
          <div style="display:flex;gap:0.3rem;margin-bottom:0.3rem;align-items:center;" class="mv-row">
            <input type="text" class="config-mv-label" data-idx="${i}" value="${escapeHtml(m.label||'')}" placeholder="Label" style="flex:1;">
            <select class="config-mv-metric" data-idx="${i}" style="flex:1;">${generateMetricOptionsHtml(m.metric)}</select>
            <input type="text" class="config-mv-unit" data-idx="${i}" value="${escapeHtml(m.unit||'')}" placeholder="Unit" style="width:50px;">
            <button type="button" class="remove-mv-btn" data-idx="${i}" style="padding:0.2rem 0.4rem;color:#ef4444;">✕</button>
          </div>`).join('');
        configPanel.innerHTML = `<h4>Metrics</h4><div id="mv-rows">${rows}</div><button type="button" class="add-mv-btn fetch-btn" style="width:100%;margin-top:0.5rem;">+ Add Metric</button><button class="fetch-btn save-config" style="margin-top:0.5rem;">Save</button>`;
      } else if (block.type === 'flow-card-square' || block.type === 'flow-card-square-2') {
        const currentMetrics = block.config?.metrics || {};
        const roles = [{ key: 'solar', label: 'Solar Power' }, { key: 'grid', label: 'Grid Power' }, { key: 'battery_power', label: 'Battery Power' }, { key: 'battery_soc', label: 'Battery SOC' }, { key: 'consumption', label: 'Consumption' }];
        configPanel.innerHTML = `<label>Inverter Image URL</label><input type="text" class="config-inverter-image" value="${escapeHtml(block.config?.inverter_image||'')}" placeholder="https://..." style="width:100%;margin-bottom:0.5rem;"><h4>Metric Mapping</h4>${roles.map(r => `<label>${escapeHtml(r.label)}</label><select class="config-metric" data-role="${r.key}" style="width:100%;margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics[r.key])}</select>`).join('')}<button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'gauge-card' || block.type === 'half-gauge' || block.type === 'half-gauge-2') {
        const isHalf = block.type === 'half-gauge' || block.type === 'half-gauge-2';
        configPanel.innerHTML = `
          <label>Title</label><input type="text" class="config-title" value="${escapeHtml(block.config?.title||'Gauge')}" style="width:100%;margin-bottom:0.5rem;">
          <label>Metric</label><select class="config-metric" data-role="value" style="width:100%;margin-bottom:0.5rem;">${generateMetricOptionsHtml(block.config?.metric)}</select>
          <label>Min</label><input type="number" class="config-min" value="${block.config?.min ?? (isHalf ? -100 : 0)}" style="width:100%;margin-bottom:0.5rem;">
          <label>Max</label><input type="number" class="config-max" value="${block.config?.max ?? 100}" style="width:100%;margin-bottom:0.5rem;">
          <label>Color</label><input type="color" class="config-color" value="${escapeHtml(block.config?.color||'#3b82f6')}" style="width:100%;margin-bottom:0.5rem;">
          <button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'text-card') {
        configPanel.innerHTML = `<label>Content (HTML/Markdown)</label><textarea class="config-content" style="width:100%;height:150px;margin-bottom:0.5rem;">${escapeHtml(block.config?.content||'')}</textarea><button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'iframe-card') {
        configPanel.innerHTML = `<label>URL</label><input type="text" class="config-url" value="${escapeHtml(block.config?.url||'')}" placeholder="https://..." style="width:100%;margin-bottom:0.5rem;"><button class="fetch-btn save-config">Save</button>`;
      } else if (block.type === 'forecast-pvtoday') {
        const currentMetrics = block.config?.metrics || {};
        configPanel.innerHTML = `<label>Location Name</label><input type="text" class="config-location" value="${escapeHtml(block.config?.location_name||'')}" placeholder="e.g. Shomolu, NG" style="width:100%;margin-bottom:0.5rem;"><label>Generated Curve Metric</label><select class="config-metric" data-role="generated" style="width:100%;margin-bottom:0.5rem;">${generateMetricOptionsHtml(currentMetrics.generated, 'solar (default)')}</select><button class="fetch-btn save-config">Save</button>`;
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
            // removed
          } else if (block.type === 'flow-card-2') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
            block.config.inverter_image = configPanel.querySelector('.config-inverter-image')?.value || '';
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
          } else if (block.type === 'forecast-banner' || block.type === 'forecast-sparkline') {
            block.config.metrics = {};
            configPanel.querySelectorAll('.config-metric').forEach(select => {
              const role = select.dataset.role;
              if (select.value) block.config.metrics[role] = select.value;
            });
          } else if (block.type === 'weather-block') {
            // removed
          } else if (block.type === 'savings-summary') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
            block.config.showToday = configPanel.querySelector('.config-show-today')?.checked ?? true;
            block.config.showWeek = configPanel.querySelector('.config-show-week')?.checked ?? true;
            block.config.showMonth = configPanel.querySelector('.config-show-month')?.checked ?? true;
            block.config.showAll = configPanel.querySelector('.config-show-all')?.checked ?? true;
          } else if (block.type === 'multi-value') {
            block.config.metrics = [];
            configPanel.querySelectorAll('.config-mv-label').forEach(l => {
              const i = parseInt(l.dataset.idx);
              const m = configPanel.querySelector(`.config-mv-metric[data-idx="${i}"]`);
              const u = configPanel.querySelector(`.config-mv-unit[data-idx="${i}"]`);
              if (l && m) block.config.metrics.push({ label: l.value, metric: m.value, unit: u?.value || '' });
            });
          } else if (block.type === 'flow-card-square' || block.type === 'flow-card-square-2') {
            block.config.inverter_image = configPanel.querySelector('.config-inverter-image')?.value || '';
            block.config.metrics = {};
            configPanel.querySelectorAll('.config-metric').forEach(select => { const role = select.dataset.role; if (select.value) block.config.metrics[role] = select.value; });
          } else if (block.type === 'gauge-card' || block.type === 'half-gauge' || block.type === 'half-gauge-2') {
            block.config.title = configPanel.querySelector('.config-title')?.value || '';
            block.config.metric = configPanel.querySelector('.config-metric')?.value || '';
            const minVal = parseFloat(configPanel.querySelector('.config-min')?.value);
            block.config.min = isNaN(minVal) ? (isHalf ? -100 : 0) : minVal;
            block.config.max = parseFloat(configPanel.querySelector('.config-max')?.value) || 100;
            block.config.color = configPanel.querySelector('.config-color')?.value || '#3b82f6';
          } else if (block.type === 'text-card') {
            block.config.content = configPanel.querySelector('.config-content')?.value || '';
          } else if (block.type === 'iframe-card') {
            block.config.url = configPanel.querySelector('.config-url')?.value || '';
          } else if (block.type === 'forecast-pvtoday') {
            block.config.location_name = configPanel.querySelector('.config-location')?.value || '';
            block.config.metrics = {};
            configPanel.querySelectorAll('.config-metric').forEach(s => { const r = s.dataset.role; if (s.value) block.config.metrics[r] = s.value; });
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
      // Attach add/remove metric handlers for multi-value config panels
      if (block.type === 'multi-value') {
        const addBtn = configPanel.querySelector('.add-mv-btn');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            const rows = configPanel.querySelectorAll('.mv-row');
            const newIdx = rows.length;
            const newRow = document.createElement('div');
            newRow.className = 'mv-row';
            newRow.style.cssText = 'display:flex;gap:0.3rem;margin-bottom:0.3rem;align-items:center;';
            newRow.innerHTML = `<input type="text" class="config-mv-label" data-idx="${newIdx}" placeholder="Label" style="flex:1;"><select class="config-mv-metric" data-idx="${newIdx}" style="flex:1;">${generateMetricOptionsHtml('')}</select><input type="text" class="config-mv-unit" data-idx="${newIdx}" placeholder="Unit" style="width:50px;"><button type="button" class="remove-mv-btn" data-idx="${newIdx}" style="padding:0.2rem 0.4rem;color:#ef4444;">✕</button>`;
            newRow.querySelector('.remove-mv-btn').addEventListener('click', () => newRow.remove());
            addBtn.before(newRow);
          });
        }
        configPanel.querySelectorAll('.remove-mv-btn').forEach(btn => {
          btn.addEventListener('click', (e) => { btn.closest('.mv-row').remove(); });
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
    li.querySelector('.block-bg-color').addEventListener('change', (e) => {
      dashboard.layout[idx].bgColor = e.target.value;
    });
    li.querySelector('.block-transparent').addEventListener('change', (e) => {
      dashboard.layout[idx].transparent = e.target.checked;
    });
    li.querySelector('.block-font-color').addEventListener('change', (e) => {
      dashboard.layout[idx].fontColor = e.target.value;
    });
    li.querySelector('.block-font-size').addEventListener('change', (e) => {
      dashboard.layout[idx].fontSize = e.target.value || '';
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
    dashboard.layout.push({
      id: 'block_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      type: 'flow-card',
      enabled: true,
      colSpan: 12,
      rowSpan: 0,
      config: {}
    });
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
  payload.dongle_config = collectDeviceArray('dongle-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.profile = card.querySelector('.dongle-profile-select').value;
    dev.transport = card.querySelector('input[name$="[transport]"]').value;
    dev.host = card.querySelector('input[name$="[host]"]').value;
    dev.port = parseInt(card.querySelector('input[name$="[port]"]').value) || undefined;
    dev.serial_number = card.querySelector('input[name$="[serial_number]"]')?.value || '';
    dev.modbus_unit_id = parseInt(card.querySelector('input[name$="[modbus_unit_id]"]').value) || 1;
    dev.poll_interval = parseInt(card.querySelector('input[name$="[poll_interval]"]').value) || 30;
    dev.prefix = card.querySelector('input[name$="[prefix]"]')?.value || '';
    return dev;
  });
  payload.pvoutput_config = JSON.stringify(collectPvoutputConfig());
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
