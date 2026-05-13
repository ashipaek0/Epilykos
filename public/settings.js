// settings.js – with dynamic metric mapping, tooltips, and metric-cards block editor
// + Export/Import layout

const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');
const backupStatus = document.getElementById('backup-status');
let usedDashboardMetrics = [];

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
    const res = await fetch('/api/settings');
    const data = await res.json();
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
    buildHaDeviceList(JSON.parse(data.ha_devices || '[]'));
    buildMqttDeviceList(JSON.parse(data.mqtt_devices || '[]'));
    buildModbusDeviceList(JSON.parse(data.modbus_devices || '[]'));
    const dashConfig = data.dashboard_config ? JSON.parse(data.dashboard_config) : null;
    buildDashboardEditor(dashConfig);

    usedDashboardMetrics = [];
    if (dashConfig && dashConfig.dashboards) {
      dashConfig.dashboards.forEach(db => {
        db.layout.forEach(block => {
          if (block.type === 'metric-cards' && block.cards) {
            block.cards.forEach(card => {
              if (card.metric && !usedDashboardMetrics.includes(card.metric)) {
                usedDashboardMetrics.push(card.metric);
              }
            });
          }
        });
      });
    }
    usedDashboardMetrics.sort();

    try {
      const metricsRes = await fetch('/api/metrics/names');
      window._allStoredMetrics = await metricsRes.json();
    } catch (e) {
      window._allStoredMetrics = [];
    }
  } catch (e) {
    showStatus(saveStatus, 'Failed to load settings', 'error');
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
        <span class="metric-help-icon" data-tooltip="${escapeHtml(usedDashboardMetrics.join(', ') || 'none yet')}">?</span>
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
      const selects = card.querySelectorAll('.mappings-list select');
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
      const dashboardText = helpIcon.dataset.tooltip || '';
      const storedMetrics = window._allStoredMetrics || [];
      let tooltipText = '';
      if (dashboardText && dashboardText !== 'none yet') {
        tooltipText += 'Dashboard: ' + dashboardText;
      }
      if (storedMetrics.length) {
        if (tooltipText) tooltipText += ' | ';
        tooltipText += 'Stored: ' + storedMetrics.join(', ');
      }
      if (!tooltipText) tooltipText = 'No metrics available yet';

      const tooltip = card.querySelector('.metric-tooltip');
      tooltip.textContent = tooltipText;
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
  if (Object.keys(entities).length === 0) {
    addHaMetricRow({}, deviceIdx, container);
  }
}

function addHaMetricRow(device, deviceIdx, container, metric = '', entityId = '') {
  if (!container) {
    container = document.getElementById(`ha-mappings-list-${deviceIdx}`);
    if (!container) return;
  }
  const row = document.createElement('div');
  row.className = 'metric-row';
  row.innerHTML = `
    <input type="text" class="metric-name" placeholder="metric name" value="${escapeHtml(metric)}">
    <select class="entity-select">
      <option value="">-- Select entity --</option>
      ${entityId ? `<option value="${escapeHtml(entityId)}" selected>${escapeHtml(entityId)}</option>` : ''}
    </select>
    <button type="button" class="remove-btn remove-metric">−</button>
  `;
  row.querySelector('.remove-metric').addEventListener('click', () => {
    row.remove();
  });
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

document.getElementById('add-ha-device').addEventListener('click', () => {
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
        <span class="metric-help-icon" data-tooltip="${escapeHtml(usedDashboardMetrics.join(', ') || 'none yet')}">?</span>
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
      if (res.ok) {
        showStatus(statusEl, data.message, 'success');
      } else {
        showStatus(statusEl, data.error || 'Test failed', 'error');
      }
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
      if (res.ok) {
        showStatus(statusEl, `Received: ${data.value ?? data.raw}`, 'success');
      } else {
        showStatus(statusEl, data.error, 'error');
      }
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
      const dashboardText = helpIcon.dataset.tooltip || '';
      const storedMetrics = window._allStoredMetrics || [];
      let tooltipText = '';
      if (dashboardText && dashboardText !== 'none yet') {
        tooltipText += 'Dashboard: ' + dashboardText;
      }
      if (storedMetrics.length) {
        if (tooltipText) tooltipText += ' | ';
        tooltipText += 'Stored: ' + storedMetrics.join(', ');
      }
      if (!tooltipText) tooltipText = 'No metrics available yet';

      const tooltip = card.querySelector('.metric-tooltip');
      tooltip.textContent = tooltipText;
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
  if (Object.keys(topics).length === 0) {
    addMqttMetricRow({}, deviceIdx, container);
  }
}

function addMqttMetricRow(device, deviceIdx, container, metric = '', topic = '') {
  if (!container) {
    container = document.getElementById(`mqtt-mappings-list-${deviceIdx}`);
    if (!container) return;
  }
  const row = document.createElement('div');
  row.className = 'metric-row';
  row.innerHTML = `
    <input type="text" class="metric-name" placeholder="metric name" value="${escapeHtml(metric)}">
    <input type="text" class="topic-input" placeholder="topic" value="${escapeHtml(topic)}">
    <button type="button" class="remove-btn remove-metric">−</button>
  `;
  row.querySelector('.remove-metric').addEventListener('click', () => {
    row.remove();
  });
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

document.getElementById('add-mqtt-device').addEventListener('click', () => {
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
      <select name="modbus_devices[${idx}][profile]" class="modbus-profile-select">
        <option value="">-- Select profile --</option>
      </select>
      <input type="text" name="modbus_devices[${idx}][host]" placeholder="Host/IP" value="${escapeHtml(device.host || '')}">
    </div>
    <div class="form-row">
      <input type="number" name="modbus_devices[${idx}][port]" placeholder="Port" value="${device.port || 502}">
      <input type="number" name="modbus_devices[${idx}][unit]" placeholder="Unit ID" value="${device.unit || 1}">
    </div>
    <div class="form-row">
      <input type="number" name="modbus_devices[${idx}][poll_interval]" placeholder="Poll (s)" value="${device.poll_interval || 30}" style="width:120px;">
      <button type="button" class="fetch-btn test-modbus">Test Modbus</button>
    </div>
  `;
  container.appendChild(card);
  const select = card.querySelector('.modbus-profile-select');
  fetch('/api/modbus/profiles').then(r => r.json()).then(profiles => {
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === device.profile) opt.selected = true;
      select.appendChild(opt);
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
    try {
      const res = await fetch('/api/test-modbus');
      const data = await res.json();
      if (res.ok) {
        showStatus(statusEl, `OK: ${data.value}`, 'success');
      } else {
        showStatus(statusEl, data.error, 'error');
      }
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

document.getElementById('add-modbus-device').addEventListener('click', () => {
  const idx = modbusDeviceCounter;
  renderModbusDevice({ name: '', host: '', port: 502, unit: 1, poll_interval: 30, enabled: true, profile: '' }, idx);
});

// ======================== FORECAST TEST ========================
document.getElementById('test-forecast').addEventListener('click', async function() {
  const btn = this;
  const statusEl = document.getElementById('forecast-test-status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Testing...';
  showStatus(statusEl, 'Fetching forecast...', 'info');
  try {
    const res = await fetch('/api/test-forecast');
    const data = await res.json();
    if (res.ok) {
      showStatus(statusEl, `✅ ${data.source}: Today ~${data.today_estimate_kwh} kWh, Peak ${data.peak_kw} kW`, 'success');
    } else {
      showStatus(statusEl, `❌ ${data.error}`, 'error');
    }
  } catch (e) {
    showStatus(statusEl, `❌ Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Forecast';
  }
});

// ======================== DASHBOARD EDITOR (with metric-cards sub-editor + export/import) ========================
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
      if (dashConfig.activeDashboard === db.id) {
        dashConfig.activeDashboard = dashConfig.dashboards[0]?.id || 'main';
      }
      buildDashboardEditor(dashConfig);
    });
    row.querySelector('.dash-name').addEventListener('change', (e) => {
      db.name = e.target.value;
    });
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
      </select>
      <button type="button" class="remove-btn delete-block">Remove</button>
      <div class="card-editor-container" style="display:${block.type === 'metric-cards' ? 'block' : 'none'}; margin-top:0.5rem; width:100%;"></div>
    `;
    const select = li.querySelector('.block-type-select');
    const cardEditorContainer = li.querySelector('.card-editor-container');

    // Function to render card editor
    const renderCardEditor = () => {
      if (select.value === 'metric-cards') {
        cardEditorContainer.style.display = 'block';
        if (!block.cards) block.cards = [];
        renderMetricCardsEditor(block, cardEditorContainer);
      } else {
        cardEditorContainer.style.display = 'none';
      }
    };
    select.addEventListener('change', (e) => {
      dashboard.layout[idx].type = e.target.value;
      renderCardEditor();
    });
    renderCardEditor(); // initial render

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

  // Export/Import buttons
  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export Layout';
  exportBtn.className = 'fetch-btn';
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(dashConfig, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dashboard-layout.json';
    a.click();
    URL.revokeObjectURL(url);
  });
  container.appendChild(exportBtn);

  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import Layout';
  importBtn.className = 'fetch-btn';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (imported.dashboards && imported.activeDashboard) {
          dashConfig = imported;
          buildDashboardEditor(dashConfig);
          showStatus(saveStatus, 'Layout imported. Remember to save.', 'info');
        } else {
          showStatus(saveStatus, 'Invalid layout file', 'error');
        }
      } catch (ex) {
        showStatus(saveStatus, 'Error parsing file', 'error');
      }
    };
    reader.readAsText(file);
  });
  container.appendChild(importBtn);
  container.appendChild(fileInput);
}

function renderMetricCardsEditor(block, container) {
  container.innerHTML = '';
  if (!block.cards) block.cards = [];
  block.cards.forEach((card, cardIdx) => {
    const row = document.createElement('div');
    row.className = 'card-editor-row';
    row.innerHTML = `
      <input type="text" placeholder="Title" value="${escapeHtml(card.title || '')}" class="card-title" style="width:100px;">
      <input type="text" placeholder="Metric" value="${escapeHtml(card.metric || '')}" class="card-metric" style="width:100px;">
      <input type="text" placeholder="Unit" value="${escapeHtml(card.unit || '')}" class="card-unit" style="width:60px;">
      <button type="button" class="remove-btn remove-card">−</button>
    `;
    row.querySelector('.card-title').addEventListener('input', (e) => { card.title = e.target.value; });
    row.querySelector('.card-metric').addEventListener('input', (e) => { card.metric = e.target.value; });
    row.querySelector('.card-unit').addEventListener('input', (e) => { card.unit = e.target.value; });
    row.querySelector('.remove-card').addEventListener('click', () => {
      block.cards.splice(cardIdx, 1);
      renderMetricCardsEditor(block, container);
    });
    container.appendChild(row);
  });
  const addCardBtn = document.createElement('button');
  addCardBtn.textContent = '+ Add Card';
  addCardBtn.className = 'fetch-btn';
  addCardBtn.addEventListener('click', () => {
    block.cards.push({ id: 'card_' + Date.now(), title: '', metric: '', unit: '' });
    renderMetricCardsEditor(block, container);
  });
  container.appendChild(addCardBtn);
}

document.getElementById('add-dashboard-btn').addEventListener('click', () => {
  const newId = 'db_' + Date.now();
  dashConfig.dashboards.push({
    id: newId,
    name: 'New Tab',
    layout: []
  });
  dashConfig.activeDashboard = newId;
  buildDashboardEditor(dashConfig);
});

// ======================== SAVE ========================
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {};

  form.querySelectorAll('input[name], select[name], textarea[name]').forEach(el => {
    if (el.name.startsWith('ha_devices[') || el.name.startsWith('mqtt_devices[') || el.name.startsWith('modbus_devices[') || el.name === 'dashboard_config') return;
    if (el.type === 'checkbox') {
      payload[el.name] = el.checked ? 'true' : 'false';
    } else {
      payload[el.name] = el.value;
    }
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
      const metricName = row.querySelector('.metric-name').value.trim();
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
      const metricName = row.querySelector('.metric-name').value.trim();
      const topic = row.querySelector('.topic-input').value.trim();
      if (metricName && topic) dev.topics[metricName] = topic;
    });
    return dev;
  });

  payload.modbus_devices = collectDeviceArray('modbus-devices-container', (card) => {
    const dev = {};
    dev.name = card.querySelector('.device-header input[type="text"]').value;
    dev.enabled = card.querySelector('.device-header input[type="checkbox"]').checked;
    dev.profile = card.querySelector('.modbus-profile-select').value;
    dev.host = card.querySelector('input[name$="[host]"]').value;
    dev.port = card.querySelector('input[name$="[port]"]').value;
    dev.unit = card.querySelector('input[name$="[unit]"]').value;
    dev.poll_interval = card.querySelector('input[name$="[poll_interval]"]').value;
    return dev;
  });

  payload.dashboard_config = JSON.stringify(dashConfig);

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showStatus(saveStatus, 'Settings saved successfully!', 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      showStatus(saveStatus, err.error || 'Failed to save', 'error');
    }
  } catch (e) {
    showStatus(saveStatus, 'Error: ' + e.message, 'error');
  }
});

function collectDeviceArray(containerId, extractFn) {
  const container = document.getElementById(containerId);
  if (!container) return '[]';
  const cards = container.querySelectorAll('.device-card');
  const arr = [];
  cards.forEach(card => {
    const dev = extractFn(card);
    arr.push(dev);
  });
  return JSON.stringify(arr);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ======================== INIT ========================
loadSettings();
