/**
 * Epilykos — First-run Setup Wizard (frontend)
 * Talks to the locked /api/wizard/* + /api/settings + /api/*-source contracts.
 * Classic script; pairs with /js/csrf.js (adds X-Requested-With to non-GET).
 */
(function () {
  'use strict';

  // ── DOM helpers ───────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Reject path segments that could mutate or read the object prototype chain
  // (CWE-1321). Guards apply to BOTH setPath and getPath so the property-chain
  // walk in each is provably safe.
  function isSafeKey(k) {
    return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
  }

  function setPath(obj, path, val) {
    var parts = path.split('.');
    var cur = obj;
    // Walk only existing own properties, refusing polluted keys at every step.
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return;
      cur = cur[key];
      if (cur === null || typeof cur !== 'object') return;
    }
    var last = parts[parts.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
    cur[last] = val;
  }
  function getPath(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      if (!isSafeKey(parts[i])) return undefined; // refuse to read dangerous chains
      cur = cur[parts[i]];
    }
    return cur;
  }

  function randomString(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var arr = new Uint32Array(Math.max(len, 1));
    (window.crypto || window.msCrypto).getRandomValues(arr);
    var out = '';
    for (var i = 0; i < len; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  // ── API helper (returns {ok, status, data}) ──────────────
  function api(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['Accept'] = 'application/json';
    if (opts.method && opts.method !== 'GET') opts.headers['Content-Type'] = 'application/json';
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') > -1 && text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data: data, text: text };
      }).catch(function () { return { ok: res.ok, status: res.status, data: null }; });
    }).catch(function (err) {
      return { ok: false, status: 0, data: null, error: err };
    });
  }

  // Drop empty fields, as encodeQuery does — the server falls back to saved config for missing ones.
  function compact(obj) {
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
    }
    return out;
  }

  function encodeQuery(obj) {
    var p = [];
    for (var k in obj) {
      var v = obj[k];
      if (v !== undefined && v !== null && v !== '') {
        p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    }
    return p.length ? '?' + p.join('&') : '';
  }

  // ── Constants ─────────────────────────────────────────────
  var SOURCE_KEYS = ['ha', 'mqtt', 'dongle', 'rs232', 'modbusSerial', 'modbusTcp', 'bms', 'bmsWired', 'rest'];
  var STEPS = [
    { label: 'Password', sub: 'Protect Settings', title: 'Secure your workspace', lede: 'Set the admin password. It protects Settings and the layout editor; the dashboard itself stays open to view.' },
    { label: 'Sources', sub: 'Where data comes from', title: 'Connect your equipment', lede: 'Pick what Epilykos should read from, then fill in each connection. Testing is optional: a failed test won\'t stop you continuing.' },
    { label: 'Metrics', sub: 'What each reading means', title: 'Match readings to roles', lede: 'Tell Epilykos which reading is your solar power, battery level and so on. These drive the flow card, savings and daily totals. Leave any you don\'t have empty.' },
    { label: 'Dashboard', sub: 'Starting layout', title: 'Choose a starting dashboard', lede: 'Start with everything or a short, simple layout. You can add, remove and rearrange cards later in the layout editor.' },
    { label: 'Basics', sub: 'Name, currency, size', title: 'A few basics', lede: 'Used for the dashboard title, savings figures and the solar forecast.' },
    { label: 'Extras', sub: 'Optional', title: 'Optional extras', lede: 'Upload to PVOutput, forecast solar production, and set the addresses the app uses at home and away. Skip any of these; they\'re all in Settings later.' },
    { label: 'Finish', sub: 'Review and go', title: 'Review and finish', lede: 'Here\'s what\'s set up. Finish setup, then open your dashboard.' }
  ];
  var LAST_STEP = STEPS.length;

  // Source types offered in step 2, grouped like Settings' add-source picker.
  var SOURCE_GROUPS = [
    { label: 'Inverter', items: [
      { key: 'dongle', icon: 'dongle', name: 'WiFi or Bluetooth dongle', sub: 'Solarman, LuxPower, Growatt, Felicity sticks' },
      { key: 'modbusTcp', icon: 'network', name: 'Modbus-TCP', sub: 'Over your network, or through an RS485 gateway' },
      { key: 'modbusSerial', icon: 'register', name: 'RS485 (Modbus-RTU)', sub: 'USB to RS485 adapter' },
      { key: 'rs232', icon: 'serial', name: 'RS232 serial', sub: 'Voltronic, Victron VE.Direct and similar' }
    ] },
    { label: 'Battery', items: [
      { key: 'bms', icon: 'bluetooth', name: 'BMS over Bluetooth', sub: 'Scan for nearby batteries' },
      { key: 'bmsWired', icon: 'battery', name: 'BMS over RS485 / RS232', sub: 'Wired to this server' }
    ] },
    { label: 'Home automation and other', items: [
      { key: 'ha', icon: 'home', name: 'Home Assistant', sub: 'Read entities with a long-lived token' },
      { key: 'mqtt', icon: 'mqtt', name: 'MQTT', sub: 'Subscribe to topics on a broker' },
      { key: 'rest', icon: 'rest', name: 'REST API', sub: 'Any JSON endpoint' }
    ] }
  ];
  function sourceType(key) {
    for (var g = 0; g < SOURCE_GROUPS.length; g++) {
      for (var i = 0; i < SOURCE_GROUPS[g].items.length; i++) if (SOURCE_GROUPS[g].items[i].key === key) return SOURCE_GROUPS[g].items[i];
    }
    return { key: key, icon: 'plug', name: key, sub: '' };
  }

  var ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 004.4-1"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
    refresh: '<path d="M20 11a8 8 0 00-14.9-4M4 4v4h4M4 13a8 8 0 0014.9 4M20 20v-4h-4"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0V8zM12 16v5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
    home: '<path d="M3 11l9-7 9 7v9H3z"/><path d="M10 20v-6h4v6"/>',
    register: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
    serial: '<path d="M4 9h16v6H4z"/><path d="M8 9V6M16 9V6M8 15v3M16 15v3"/>',
    dongle: '<path d="M5 12a7 7 0 0114 0M9 12a3 3 0 016 0"/><circle cx="12" cy="12" r="1"/><path d="M12 13v7"/>',
    network: '<rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 17h.01M11 17h.01M12 14V9M8 6a6 6 0 018 0M5.5 3.5a10 10 0 0113 0"/>',
    bluetooth: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
    battery: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M10 3V1.5h4V3M9 9h6M9 13h6"/>',
    mqtt: '<path d="M4 12a8 8 0 0116 0M8 12a4 4 0 018 0"/><circle cx="12" cy="12" r="1.5"/>',
    rest: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
    wifi: '<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 10h18M10 10v11"/>',
    list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 18l-3-3c1-4 4-9.5 12-12 0 0 .5 7-6 12z"/><circle cx="14.5" cy="9.5" r="1.5"/>'
  };
  function icon(name, size) {
    var n = size || 20;
    return '<svg width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || ICONS.plug) + '</svg>';
  }
  function hydrateIcons(root) {
    $$('[data-icon]', root).forEach(function (el) {
      el.insertAdjacentHTML('afterbegin', icon(el.getAttribute('data-icon'), parseInt(el.getAttribute('data-size'), 10) || 20));
      el.removeAttribute('data-icon');
    });
  }

  // ── Markup helpers ────────────────────────────────────────
  // field(label, control, {hint, optional, span, id, hidden})
  function field(label, control, o) {
    o = o || {};
    return '<div class="wz-field' + (o.span ? ' wz-span' : '') + '"' + (o.id ? ' id="' + o.id + '"' : '') + (o.hidden ? ' style="display:none;"' : '') + '>'
      + '<label' + (o.forId ? ' for="' + o.forId + '"' : '') + '>' + esc(label) + (o.optional ? ' <span class="wz-opt">(optional)</span>' : '') + '</label>'
      + control
      + (o.hint ? '<p class="wz-hint">' + o.hint + '</p>' : '')
      + '</div>';
  }
  // input bound to a state path: inp('sources.ha.url', value, {type, placeholder, id, attrs})
  function inp(path, value, o) {
    o = o || {};
    return '<input data-field="' + path + '"' + (o.id ? ' id="' + o.id + '"' : '') + ' type="' + (o.type || 'text') + '"'
      + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '')
      + (o.type === 'number' ? ' inputmode="decimal"' : '')
      + (o.attrs || '') + ' value="' + esc(value) + '">';
  }
  // sel('sources.x.parity', [[value, label], …], current, {id})
  function sel(path, options, current, o) {
    o = o || {};
    return '<select data-field="' + path + '"' + (o.id ? ' id="' + o.id + '"' : '') + '>'
      + options.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(current) === String(x[0]) ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('')
      + '</select>';
  }
  function grid() { return '<div class="wz-grid">' + Array.prototype.join.call(arguments, '') + '</div>'; }
  function alertBox(kind, html, id) {
    return '<div class="wz-alert is-' + kind + '"' + (id ? ' id="' + id + '"' : '') + '>' + icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info', 18) + '<div>' + html + '</div></div>';
  }
  // A source's settings card: icon, title, status pill, fields, test row.
  function sourceCard(key, bodyHtml, footHtml) {
    var t = sourceType(key);
    return '<section class="source-config wz-card" data-source="' + key + '" aria-labelledby="src-' + key + '-title">'
      + '<header class="wz-card-head"><span class="wz-icon-tile">' + icon(t.icon) + '</span>'
      + '<div class="wz-card-head-text"><h2 id="src-' + key + '-title">' + esc(t.name) + '</h2><p>' + esc(t.sub) + '</p></div>'
      + '<span class="wz-pill" data-badge-src="' + key + '">Not tested</span></header>'
      + '<div class="wz-card-body">' + bodyHtml + '<div data-error="' + key + '"></div></div>'
      + '<footer class="wz-card-foot">'
      + '<button class="wz-btn wz-btn-sm" type="button" data-action="test" data-source="' + key + '">Test connection</button>'
      + (footHtml || '')
      + '<span class="wz-spacer"></span>'
      + '<button class="wz-btn-link is-danger" type="button" data-action="unselect-source" data-source="' + key + '">Remove</button>'
      + '</footer></section>';
  }
  var ROLES = [
    { key: 'solar',              label: 'Solar Power',       unit: 'W' },
    { key: 'consumption',        label: 'Home Consumption',   unit: 'W' },
    { key: 'battery_charge',     label: 'Battery Charge',     unit: 'W' },
    { key: 'battery_discharge',  label: 'Battery Discharge',  unit: 'W' },
    { key: 'grid_import',        label: 'Grid Import',        unit: 'W' },
    { key: 'grid_export',        label: 'Grid Export',        unit: 'W' },
    { key: 'battery_soc',        label: 'Battery SOC',        unit: '%' },
    { key: 'solar_voltage',      label: 'Solar Voltage',      unit: 'V' },
    { key: 'daily_solar',        label: 'Daily Solar',        unit: 'kWh' },
    { key: 'daily_consumption',  label: 'Daily Consumption',  unit: 'kWh' },
    { key: 'daily_battery_charge',    label: 'Daily Battery Charge', unit: 'kWh' },
    { key: 'daily_battery_discharge', label: 'Daily Battery Discharge', unit: 'kWh' },
    { key: 'daily_grid_import',  label: 'Daily Grid Import',  unit: 'kWh' },
    { key: 'daily_grid_export',  label: 'Daily Grid Export',  unit: 'kWh' }
  ];
  var MINIMAL_DASH_TYPES = ['system-overview', 'energy-totals', 'savings-summary'];
  var ROLE_GROUPS = [
    { label: 'Live power', hint: 'What\'s flowing right now. Drives the flow card and savings.', keys: ['solar', 'consumption', 'battery_charge', 'battery_discharge', 'grid_import', 'grid_export'] },
    { label: 'Battery and panels', keys: ['battery_soc', 'solar_voltage'] },
    { label: 'Daily totals', hint: 'Energy so far today, usually reset at midnight by the inverter.', keys: ['daily_solar', 'daily_consumption', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export'] }
  ];
  // Friendly names for the dashboard preview in step 4.
  var BLOCK_NAMES = {
    'flow-card': 'Flow card', 'flow-card-2': 'Flow card', 'flow-card-square': 'Flow square', 'flow-card-square-2': 'Flow square', 'system-topology': 'System topology',
    'metric-cards': 'Metric cards', 'multi-value': 'Multi-value', 'text-metric': 'Text value', 'gauge': 'Gauge', 'half-gauge': 'Half gauge', 'half-gauge-2': 'Half gauge',
    'bar-gauge': 'Bar gauge', 'bar-gauge-retro': 'Retro bar gauge', 'bar-single': 'Bar chart', 'bar-stacked': 'Stacked bars', 'bar-threshold': 'Threshold bars',
    'chart-power': 'Power chart', 'chart-energy': 'Daily energy', 'chart-metric': 'Metric chart', 'daily-table': 'Daily table', 'monthly-table': 'Monthly table',
    'grid-card': 'Grid status', 'savings-summary': 'Savings', 'weather-block': 'Weather', 'forecast-pvtoday': 'Solar today', 'forecast-solar': 'Solar forecast',
    'switch-block': 'Switch', 'state-select': 'Mode select', 'iframe': 'Embedded page', 'text': 'Text'
  };

  // Fresh per-source wizard state (also used by "Start fresh").
  function defaultSources() {
    return {
      ha:      { selected: false, name: 'Home Assistant', url: '', token: '', poll_interval: '30', enabled: true, entities: [], profileMetrics: [] },
      mqtt:    { selected: false, name: 'MQTT Broker', broker: '', username: '', password: '', poll_interval: '30', enabled: true, discoveredTopics: [], selectedTopics: {}, topics: {} },
      dongle:  { selected: false, name: 'Inverter (dongle)', link: 'network', profile: '', transport: 'tcp', host: '', port: '', serial_number: '', dongle_serial: '', inverter_serial: '', modbus_unit_id: '', ble_address: '', ble_write_uuid: '', ble_notify_uuid: '', poll_interval: '30', prefix: '', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null, entities: [], mappings: {}, more: [] },
      rs232:   { selected: false, more: [], name: 'Inverter (RS232)', portChoice: '', custom_path: '', profile: '', baud: '', data_bits: '', stop_bits: '', parity: '', modbus_unit_id: '', timeout: '5', poll_interval: '30', enabled: true, ports: [], portsLoaded: false, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null, entities: [], mappings: {} },
      modbusSerial: { selected: false, more: [], name: 'Inverter (RS485)', transport: 'serial', profile: '', serial_path: '', serial_baud: '9600', serial_data_bits: '8', serial_parity: 'none', serial_stop_bits: '1', unit: '1', poll_interval: '30', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null, entities: [], mappings: {} },
      modbusTcp:   { selected: false, more: [], name: 'Inverter (Modbus-TCP)', transport: 'tcp', tcp_framing: 'tcp', profile: '', host: '', port: '502', unit: '1', poll_interval: '30', enabled: true, profiles: [], profilesLoaded: false, profileMetrics: [], profileMetricsLoadedFor: null, entities: [], mappings: {} },
      bms:     { selected: false, name: 'BMS (Bluetooth)', address: '', poll_interval: '30', enabled: true, mappings: {}, sampleKeys: [] },
      bmsWired: { selected: false, name: 'BMS (RS485/RS232)', enabled: true, transport: 'wired', serial_path: '', baud: '9600', data_bits: '8', parity: 'none', stop_bits: '1', modbus_unit_id: '1', profile: '', timeout: '5000', poll_interval: '30', mappings: {}, fieldKeys: [], sampleKeys: [] },
      rest:    { selected: false, name: 'REST API', url: '', enabled: true, mappings: {} }
    };
  }

  // ── State ─────────────────────────────────────────────────
  var state = {
    status: null,
    currentStep: 1,
    isReRun: false,
    authGated: false,       // pristine first-run: password step only
    completed: false,
    busy: false,
    skipped: {},           // step number -> true when it was skipped without saving
    existing: null,
    password: { newPw: '', confirmPw: '', setupCode: '', envPw: '' },
    sources: defaultSources(),
    // Saved sources the wizard doesn't show (a second Home Assistant, inverters
    // on other profiles...), by config key. Saved back unchanged, never dropped.
    keep: {},
    roleMetrics: {},       // role -> metric name
    dashboard: { choice: 'full', layoutMap: {}, mainBlocks: [], blockCount: 0 },
    basics: { savings_currency: '€', solar_capacity_kwp: '4', dashboard_title: 'My Solar' },
    optional: {
      pvoutput: { enabled: false, api_key: '', system_id: '', timezone: '', upload_interval_minutes: '5', system_size_w: '0', net_mode: false, webhook_url: '', metric_map: {} },
      forecast: { enabled: false, latitude: '', longitude: '', tilt: '30', azimuth: '180', solcast_api_key: '', solcast_resource_id: '', loss_factor: '0.9', install_date: '' },
      network: { local_url: '', remote_url: '' }
    }
  };

  // ── Theme (client-side only) ──────────────────────────────
  function applyTheme(theme) {
    if (theme !== 'dark') theme = 'light';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); localStorage.setItem('epilykos-theme', theme); } catch (e) {}
    $$('[data-action="set-theme"]').forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-theme') === theme)); });
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    if (!saved) { try { saved = localStorage.getItem('epilykos-theme'); } catch (e) {} }
    if (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) saved = 'dark';
    applyTheme(saved || 'light');
  }

  // ── Boot ──────────────────────────────────────────────────
  function boot() {
    initTheme();
    api('/api/wizard/status').then(function (res) {
      if (!res.ok || !res.data) { showFatal(); return; }
      state.status = res.data;
      isAuthenticated().then(function (auth) {
        if (state.status.completed) {
          if (!auth) { showAlreadySetup(); return; }
          // Authenticated re-run: skip password, start additive at step 2
          state.authGated = false;
          state.isReRun = true;
          state.currentStep = 2;
          markStepDone(1);
          revealWizard();
          loadExistingConfig().then(function () { gotoStep(state.currentStep); }).catch(function () { gotoStep(state.currentStep); });
          return;
        }
        if (state.status.needsSetup && !auth) {
          state.authGated = true;
          state.isReRun = false;
          state.currentStep = 1;
          hideStepperNav();
          revealWizard();
          gotoStep(1);
          return;
        }
        state.authGated = false;
        if (!state.status.needsSetup) {
          state.isReRun = true;
          state.currentStep = 2;
          markStepDone(1);
        } else {
          state.currentStep = 1;
        }
        revealWizard();
        loadExistingConfig().then(function () { gotoStep(state.currentStep); }).catch(function () { gotoStep(state.currentStep); });
      });
    }).catch(function () { showFatal(); });
  }

  function loadExistingConfig() {
    return api('/api/settings').then(function (res) {
      if (!res.ok || !res.data) return;
      state.existing = res.data;
      prefillSources(res.data);
      prefillRoleMetrics(res.data);
      prefillDashboard(res.data);
      prefillBasics(res.data);
      prefillOptional(res.data);
    }).catch(function () {});
  }

  function prefillSources(cfg) {
    var bySrc = { ha: cfg.ha_devices, mqtt: cfg.mqtt_devices, dongle: cfg.dongle_config, rs232: cfg.rs232_devices, modbus: cfg.modbus_devices, bms: cfg.bms_devices, rest: cfg.external_sources };
    function asArray(v) { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { var a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; } } return []; }
    // Parse each list once, so entries can be compared by identity below.
    Object.keys(bySrc).forEach(function (k) { bySrc[k] = asArray(bySrc[k]); });
    // The wizard edits the first of each kind; keep the others as they are.
    state.keep = {
      ha_devices: asArray(bySrc.ha).slice(1), mqtt_devices: asArray(bySrc.mqtt).slice(1), rs232_devices: [], external_sources: asArray(bySrc.rest).slice(1),
      modbus_devices: [],
      bms_devices: (function () { var ble = false, wired = false; return asArray(bySrc.bms).filter(function (d) { if (!d) return false; if (d.transport === 'wired') { if (!wired) { wired = true; return false; } return true; } if (!ble) { ble = true; return false; } return true; }); })(),
      dongle_config: []
    };
    // More inverters on the first one's profile become "more inverters like this one".
    var dgAll = asArray(bySrc.dongle);
    state.sources.dongle.more = [];
    dgAll.slice(1).forEach(function (d) {
      if (d && dgAll[0] && d.profile === dgAll[0].profile && d.transport === dgAll[0].transport) state.sources.dongle.more.push({ name: d.name || '', ble_address: d.ble_address || '', host: d.host || '', port: d.port || '', serial_number: d.serial_number || '', prefix: d.prefix || '', poll_interval: d.poll_interval, _saved: d });
      else if (d) state.keep.dongle_config.push(d);
    });
    // Same for Modbus (per transport) and RS232: units on the first one's profile
    // become extra rows; anything else is kept as it is.
    var asExtra = function (d) { return { name: d.name || '', prefix: d.prefix || '', host: d.host || '', port: d.port || '', unit: d.unit != null ? String(d.unit) : '', serial_path: d.serial_path || '', _saved: d }; };
    var firstOf = {};
    state.sources.modbusSerial.more = []; state.sources.modbusTcp.more = []; state.sources.rs232.more = [];
    asArray(bySrc.modbus).forEach(function (mb) {
      if (!mb) return;
      var kind = mb.transport === 'serial' ? 'modbusSerial' : 'modbusTcp';
      if (!firstOf[kind]) { firstOf[kind] = mb; return; }
      if (mb.profile === firstOf[kind].profile && mb.prefix) state.sources[kind].more.push(asExtra(mb));
      else state.keep.modbus_devices.push(mb);
    });
    asArray(bySrc.rs232).slice(1).forEach(function (d) {
      var first = asArray(bySrc.rs232)[0];
      if (d && first && d.profile === first.profile && d.prefix) state.sources.rs232.more.push(asExtra(d));
      else if (d) state.keep.rs232_devices.push(d);
    });
    var ha = asArray(bySrc.ha)[0]; if (ha) { Object.assign(state.sources.ha, { selected: true, name: ha.name || 'Home Assistant', url: ha.url || '', token: ha.token || '', poll_interval: String(ha.poll_interval || 30), entities: Object.keys(ha.entities || {}) }); }
    var mq = asArray(bySrc.mqtt)[0]; if (mq) { Object.assign(state.sources.mqtt, { selected: true, name: mq.name || 'MQTT Broker', broker: mq.broker || '', username: mq.username || '', password: mq.password || '', poll_interval: String(mq.poll_interval || 30), selectedTopics: mq.topics || {}, topics: mq.topics || {} }); }
    var dg = asArray(bySrc.dongle)[0]; if (dg) { Object.assign(state.sources.dongle, { selected: true, name: dg.name || 'Inverter (dongle)', link: /^ble-/.test(dg.transport || '') ? 'bluetooth' : 'network', profile: dg.profile || '', transport: dg.transport || 'tcp', host: dg.host || '', port: dg.port || '', serial_number: dg.serial_number || '', dongle_serial: dg.dongle_serial || '', inverter_serial: dg.inverter_serial || '', modbus_unit_id: dg.modbus_unit_id || '', ble_address: dg.ble_address || '', ble_write_uuid: dg.ble_write_uuid || '', ble_notify_uuid: dg.ble_notify_uuid || '', poll_interval: String(dg.poll_interval || 30), prefix: dg.prefix || '', mappings: dg.mappings || {} }); }
    var rs = asArray(bySrc.rs232)[0]; if (rs) {
      Object.assign(state.sources.rs232, { selected: true, name: rs.name || 'Inverter (RS232)', portChoice: rs.serial_path || '', profile: rs.profile || '', baud: rs.baud || '', data_bits: rs.data_bits || '', stop_bits: rs.stop_bits || '', parity: rs.parity || '', modbus_unit_id: rs.modbus_unit_id || '', timeout: String(rs.timeout || 5), mappings: rs.mappings || {} });
    }
    // Modbus: split saved entries by transport into the serial / tcp wizard slots.
    asArray(bySrc.modbus).forEach(function (mb) {
      if (!mb || (mb !== firstOf.modbusSerial && mb !== firstOf.modbusTcp)) return;
      if (mb.transport === 'serial') {
        Object.assign(state.sources.modbusSerial, { selected: true, name: mb.name || 'Inverter (RS485)', profile: mb.profile || '', serial_path: mb.serial_path || '', serial_baud: mb.serial_baud || '9600', serial_data_bits: mb.serial_data_bits || '8', serial_parity: mb.serial_parity || 'none', serial_stop_bits: mb.serial_stop_bits || '1', unit: mb.unit || '1', poll_interval: String(mb.poll_interval || 30), mappings: mb.mappings || {} });
      } else {
        Object.assign(state.sources.modbusTcp, { selected: true, name: mb.name || 'Inverter (Modbus-TCP)', tcp_framing: mb.tcp_framing === 'rtu' ? 'rtu' : 'tcp', profile: mb.profile || '', host: mb.host || '', port: mb.port || '502', unit: mb.unit || '1', poll_interval: String(mb.poll_interval || 30), mappings: mb.mappings || {} });
      }
    });
    var bm = asArray(bySrc.bms).filter(function (d) { return d && d.transport !== 'wired'; })[0]; if (bm) { Object.assign(state.sources.bms, { selected: true, name: bm.name || 'BMS (Bluetooth)', address: bm.address || '', poll_interval: String(bm.poll_interval || 30), mappings: bm.mappings || {} }); }
    var bw = (asArray(bySrc.bms) || []).find(function (d) { return d && d.transport === 'wired'; }); if (bw) { Object.assign(state.sources.bmsWired, { selected: true, name: bw.name || 'BMS (RS485/RS232)', serial_path: bw.serial_path || '', baud: String(bw.baud || 9600), data_bits: String(bw.data_bits || 8), parity: bw.parity || 'none', stop_bits: String(bw.stop_bits || 1), modbus_unit_id: String(bw.modbus_unit_id || 1), profile: bw.profile || '', timeout: String(bw.timeout || 5000), poll_interval: String(bw.poll_interval || 30), mappings: bw.mappings || {} }); }
    var rx = asArray(bySrc.rest)[0]; if (rx) { Object.assign(state.sources.rest, { selected: true, name: rx.name || 'REST API', url: rx.url || '', mappings: rx.mappings || {} }); }
    // Re-seed wizard discovery results (HA entities, MQTT selectedTopics,
    // dongle/RS232 mappings) so the metrics step has candidates without
    // re-probing. Stored in the wizard-owned setup_probe_cache key.
    if (cfg.setup_probe_cache) {
      var cache = null;
      if (typeof cfg.setup_probe_cache === 'string') { try { cache = JSON.parse(cfg.setup_probe_cache); } catch (e) { cache = null; } }
      else if (cfg.setup_probe_cache && typeof cfg.setup_probe_cache === 'object') { cache = cfg.setup_probe_cache; }
      if (cache && typeof cache === 'object') {
        if (Array.isArray(cache.ha)) state.sources.ha.entities = cache.ha;
        if (cache.mqtt && typeof cache.mqtt === 'object') state.sources.mqtt.selectedTopics = cache.mqtt;
        if (cache.dongle && typeof cache.dongle === 'object' && !Object.keys(state.sources.dongle.mappings || {}).length) state.sources.dongle.mappings = cache.dongle;
        if (cache.rs232 && typeof cache.rs232 === 'object' && !Object.keys(state.sources.rs232.mappings || {}).length) state.sources.rs232.mappings = cache.rs232;
      }
    }
  }
  function prefillRoleMetrics(cfg) {
    var rm = cfg.role_metrics;
    if (!rm) return;
    if (typeof rm === 'string') { try { rm = JSON.parse(rm); } catch (e) { rm = null; } }
    if (rm && typeof rm === 'object') state.roleMetrics = Object.assign({}, rm);
  }
  function prefillDashboard(cfg) {
    state.dashboard.layoutMap = normalizeLayouts(cfg.dashboard_layouts);
    var main = state.dashboard.layoutMap.main || [];
    // Use stored active layout if it's a real layout entry
    if (typeof main === 'object' && main && main.blocks) main = main.blocks;
    state.dashboard.mainBlocks = Array.isArray(main) ? main : [];
    state.dashboard.blockCount = state.dashboard.mainBlocks.length;
  }
  function prefillBasics(cfg) {
    // Only values someone saved replace the defaults (a fresh install stores
    // these keys empty, which used to blank the fields and block Continue).
    var set = function (v) { return v != null && String(v).trim() !== ''; };
    if (set(cfg.savings_currency)) state.basics.savings_currency = cfg.savings_currency;
    if (set(cfg.solar_capacity_kwp)) state.basics.solar_capacity_kwp = String(cfg.solar_capacity_kwp);
    if (set(cfg.dashboard_title)) state.basics.dashboard_title = cfg.dashboard_title;
    // PV arrays from Settings › Forecast: the forecast uses this list when present.
    var arrays = [];
    try { arrays = typeof cfg.solar_arrays === 'string' ? JSON.parse(cfg.solar_arrays || '[]') : (cfg.solar_arrays || []); } catch (e) { arrays = []; }
    state.basics.arrays = Array.isArray(arrays) ? arrays.filter(function (a) { return a && Number(a.kwp) > 0; }) : [];
  }
  function prefillOptional(cfg) {
    // Defensive: this must never throw, even on malformed / partial config.
    if (!cfg || typeof cfg !== 'object') return;
    var present = function (v) { return v !== undefined && v !== null && v !== ''; };

    // PVOutput — cfg.pvoutput_config is a JSON STRING (see settings.js JSON.stringify/JSON.parse).
    if (present(cfg.pvoutput_config)) {
      var pv = null;
      if (typeof cfg.pvoutput_config === 'string') {
        try { pv = JSON.parse(cfg.pvoutput_config); } catch (e) { pv = null; }
      } else {
        pv = cfg.pvoutput_config;
      }
      if (pv && typeof pv === 'object') {
        var pvPatch = {};
        ['enabled', 'api_key', 'system_id', 'timezone', 'upload_interval_minutes', 'system_size_w', 'net_mode', 'webhook_url'].forEach(function (k) {
          if (present(pv[k])) pvPatch[k] = pv[k];
        });
        if (pvPatch.enabled !== undefined) pvPatch.enabled = !!pvPatch.enabled;
        // Issue #117 (D6/AC-11): carry the existing metric_map — including the
        // v1_unit/v3_unit energy-unit selections — through the wizard.
        // saveConfigKeys uses INSERT OR REPLACE for the whole pvoutput_config
        // value, so omitting this key here would silently wipe it.
        pvPatch.metric_map = (pv.metric_map && typeof pv.metric_map === 'object') ? pv.metric_map : {};
        Object.assign(state.optional.pvoutput, pvPatch);
      }
    }

    // Forecast — individual solar_* / solcast_* keys.
    var fg = state.optional.forecast;
    [
      ['forecast_enabled', 'enabled'],
      ['solar_latitude', 'latitude'],
      ['solar_longitude', 'longitude'],
      ['solar_tilt', 'tilt'],
      ['solar_azimuth', 'azimuth'],
      ['solcast_api_key', 'solcast_api_key'],
      ['solcast_resource_id', 'solcast_resource_id'],
      ['solar_loss_factor', 'loss_factor'],
      ['solar_install_date', 'install_date']
    ].forEach(function (pair) {
      var v = cfg[pair[0]];
      if (present(v)) fg[pair[1]] = v;
    });
    // Stored as the string 'true' / 'false'; !!'false' would read as on.
    if (fg.enabled !== undefined) fg.enabled = truthy(fg.enabled);

    // Network
    var net = state.optional.network;
    if (present(cfg.network_local_url)) net.local_url = cfg.network_local_url;
    if (present(cfg.network_remote_url)) net.remote_url = cfg.network_remote_url;
  }

  function normalizeLayouts(raw) {
    var map = {};
    if (!raw) return map;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return map; } }
    if (Array.isArray(raw)) {
      raw.forEach(function (l) { if (l && (l.id || l.name)) map[l.id || l.name] = l.blocks || l.layout || []; });
    } else if (typeof raw === 'object') {
      for (var k in raw) {
        map[k] = raw[k];
      }
    }
    return map;
  }

  // ── Auth probe ────────────────────────────────────────────
  // /api/auth/status answers either way (a protected call would log a 401 on every first visit).
  function isAuthenticated() {
    return api('/api/auth/status').then(function (res) {
      return !!(res.ok && res.data && res.data.authenticated);
    }).catch(function () { return false; });
  }

  // ── Screen switching ──────────────────────────────────────
  function showScreen(id) {
    ['boot-screen', 'fatal-screen', 'already-setup', 'wizard'].forEach(function (s) {
      var el = $('#' + s);
      if (el) el.hidden = (s !== id);
    });
    var prog = $('#wz-top-progress'); if (prog) prog.hidden = (id !== 'wizard') || state.authGated;
  }
  function showFatal() { showScreen('fatal-screen'); }
  function showAlreadySetup() { showScreen('already-setup'); }
  function revealWizard() { showScreen('wizard'); }

  function setGlobalError(msg) {
    var el = $('#wizard-global-error');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
  }

  // In auth-gated (pristine first-run) mode the spec shows the Password
  // step only, so the stepper + Back/Next nav are hidden until the
  // password is set (auto-login) and the rest is revealed.
  function hideStepperNav() {
    var w = $('#wizard'); if (w) w.classList.add('is-gated');
    var g = $('#wizard-global-error'); if (g) g.hidden = true;
    var prog = $('#wz-top-progress'); if (prog) prog.hidden = true;
  }
  function showStepperNav() {
    var w = $('#wizard'); if (w) w.classList.remove('is-gated');
    var prog = $('#wz-top-progress'); if (prog) prog.hidden = false;
  }

  // ── Stepper ───────────────────────────────────────────────
  function renderStepper() {
    var ol = $('#wizard-steps');
    var first = state.isReRun ? 2 : 1;
    var html = '';
    STEPS.forEach(function (st, idx) {
      var n = idx + 1;
      if (n < first) return;
      var cur = n === state.currentStep && !state.completed;
      var done = n < state.currentStep || state.completed;
      var skipped = done && !!state.skipped[n];
      html += '<li class="wz-step' + (cur ? ' is-current' : '') + (done ? ' is-done' : '') + (skipped ? ' is-skipped' : '') + '">'
        + '<button type="button" class="wz-step-btn" data-action="goto-step" data-step="' + n + '"' + (cur ? ' aria-current="step"' : '') + (done ? '' : ' tabindex="-1" aria-disabled="true"') + '>'
        + '<span class="wz-step-num">' + (skipped ? '–' : done ? icon('check', 16) : (n - first + 1)) + '</span>'
        + '<span class="wz-step-text"><span class="wz-step-label">' + esc(st.label) + '</span><span class="wz-step-sub">' + (skipped ? 'Skipped' : esc(st.sub)) + '</span></span>'
        + '</button></li>';
    });
    ol.innerHTML = html;
    var total = LAST_STEP - first + 1, pos = state.currentStep - first + 1;
    var t = $('#wz-top-progress-text'); if (t) t.textContent = 'Step ' + pos + ' of ' + total;
    var bar = $('#wz-progress-bar'); if (bar) bar.style.width = Math.round(pos / total * 100) + '%';
  }
  function markStepDone(step) { renderStepper(); }

  // ── Step navigation ───────────────────────────────────────
  function gotoStep(n) {
    if (n < 1) n = 1;
    if (n > LAST_STEP) n = LAST_STEP;
    state.currentStep = n;
    if (n > 1) state.progressAtLeast = n;
    renderStepper();
    var first = state.isReRun ? 2 : 1;
    $$('.wizard-panel').forEach(function (p) {
      var step = parseInt(p.getAttribute('data-step'), 10);
      var on = step === n;
      p.classList.toggle('active', on);
      if (!on) return;
      var meta = STEPS[step - 1];
      $('[data-step-eyebrow]', p).textContent = state.authGated ? 'First-run setup' : 'Step ' + (step - first + 1) + ' of ' + (LAST_STEP - first + 1);
      $('[data-step-title]', p).textContent = meta.title;
      $('[data-step-lede]', p).textContent = meta.lede;
    });
    setGlobalError(null);
    setNavHint('');
    renderStepBody(n);
    updateNav();
    window.scrollTo({ top: 0 });
    var title = $('.wizard-panel.active [data-step-title]');
    if (title && document.activeElement && document.activeElement !== document.body) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
  }

  function renderStepBody(n) {
    var body = $('#step-' + n + '-body');
    if (!body) return;
    if (n === 1) renderStep1();
    else if (n === 2) renderStep2();
    else if (n === 3) renderStep3();
    else if (n === 4) renderStep4();
    else if (n === 5) renderStep5();
    else if (n === 6) renderStepOptional();
    else if (n === 7) renderStepFinish();
    hydrateIcons(body);
  }

  // ── VALIDATION ────────────────────────────────────────────
  function validNewPassword() {
    var p = state.password;
    return p.newPw && p.newPw.length >= 4 && p.newPw === p.confirmPw;
  }
  function selectedSourcesCount() {
    return SOURCE_KEYS.filter(function (k) { return state.sources[k].selected; }).length;
  }
  function basicsValid() {
    var b = state.basics;
    var cap = String(b.solar_capacity_kwp == null ? '' : b.solar_capacity_kwp).trim();
    return b.savings_currency.trim() !== '' && (cap === '' || (!isNaN(Number(cap)) && Number(cap) >= 0)) && b.dashboard_title.trim() !== '';
  }
  // Whether Continue is enabled. Missing fields don't disable it: pressing it
  // explains what's missing instead (see onNext).
  function canGoNext(step) {
    if (step === 1) return state.status ? (state.status.passwordEnvManaged ? true : validNewPassword()) : false;
    return true;
  }
  function unassignedCount() {
    return ROLES.filter(function (r) { return !((state.roleMetrics[r.key] || '').trim()); }).length;
  }
  function roleCountLabel() {
    var set = ROLES.length - unassignedCount();
    if (!set) return 'No roles matched yet. You can skip this and do it in Settings.';
    return set + ' of ' + ROLES.length + ' roles matched';
  }

  function updateNav() {
    if (state.authGated) return;
    var next = $('#next-btn');
    var back = $('#back-btn');
    var skip = $('#skip-btn');
    var firstVisible = state.isReRun ? 2 : 1;
    back.hidden = !(state.currentStep > firstVisible) || state.completed;
    skip.hidden = !isSkippable(state.currentStep) || state.completed;
    if (next) {
      if (!state.busy) next.disabled = !canGoNext(state.currentStep);
      next.textContent = state.currentStep === LAST_STEP ? (state.completed ? 'Open dashboard' : 'Finish setup') : 'Continue';
    }
    var hintEl = $('#nav-hint');
    if (hintEl && !hintEl.classList.contains('is-error')) {
      var hint = '';
      if (state.currentStep === 2 && selectedSourcesCount() === 0) hint = 'Nothing picked: Continue skips this. Add sources in Settings any time.';
      else if (state.currentStep === 3) hint = roleCountLabel();
      hintEl.textContent = hint;
    }
  }
  // Every step between the password and the review can be skipped. Skipping
  // moves on without saving that step; Continue saves it.
  function isSkippable(step) { return step > 1 && step < LAST_STEP; }
  function skipStep() {
    var step = state.currentStep;
    if (!isSkippable(step)) return;
    state.skipped[step] = true;
    gotoStep(step + 1);
  }

  // An error in the nav bar stays until the next step change or Continue.
  function setNavHint(msg, isError) {
    var el = $('#nav-hint');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!(msg && isError));
  }

  // ── STEP 1: PASSWORD ──────────────────────────────────────
  function renderStep1() {
    var body = $('#step-1-body');
    var envManaged = state.status && state.status.passwordEnvManaged;
    state.password.newPw = '';
    state.password.confirmPw = '';
    state.password.setupCode = '';
    state.password.envPw = '';

    var html = '<div class="wz-card"><div class="wz-card-body">';
    if (envManaged) {
      if (state.authGated) {
        // Prove the server-side password before the wizard unlocks.
        html += alertBox('info', 'This server\'s admin password is set with the <code>SETTINGS_PASSWORD</code> environment variable. Enter it to continue.')
          + '<div style="height:16px"></div>'
          + field('Admin password', passwordInput('password.envPw', 'pw-env', 'current-password'), { forId: 'pw-env' });
      } else {
        html += alertBox('info', 'The admin password is set with the <code>SETTINGS_PASSWORD</code> environment variable, so there\'s nothing to do here.');
      }
    } else {
      if (state.authGated) {
        html += field('Setup code', '<input id="pw-setup-code" class="wz-code-input" data-field="password.setupCode" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="8" placeholder="XXXXXXXX">', {
          forId: 'pw-setup-code',
          hint: 'An 8-character code printed in the server log when Epilykos starts, for example with <code>docker logs epilykos</code>. It proves you run this server.'
        });
      }
      html += grid(
        field('New password', passwordInput('password.newPw', 'pw-new', 'new-password'), { forId: 'pw-new' }),
        field('Confirm password', passwordInput('password.confirmPw', 'pw-confirm', 'new-password'), { forId: 'pw-confirm' })
      )
        + '<ul class="wz-reqs" id="pw-reqs"><li data-req="len">At least 4 characters</li><li data-req="match">Both passwords match</li></ul>'
        + '<div class="wz-actions"><button class="wz-btn wz-btn-sm" type="button" data-action="regenerate">' + icon('refresh', 16) + 'Generate a strong password</button>'
        + '<button class="wz-btn wz-btn-sm" type="button" data-action="copy-password" id="pw-copy" hidden>' + icon('copy', 16) + 'Copy</button></div>'
        + '<p class="wz-hint" id="pw-msg" style="margin-top:12px">Keep it somewhere safe: it unlocks Settings and the REST API.</p>';
    }
    html += '</div>';
    if (state.authGated) {
      html += '<div class="wz-card-foot"><span class="wz-spacer"></span><button class="wz-btn wz-btn-primary" type="button" data-action="password-submit" id="pw-submit">'
        + (envManaged ? 'Continue' : 'Set password and continue') + '</button></div>';
    }
    html += '</div>';
    body.innerHTML = html;
    syncPasswordReqs();
  }
  function passwordInput(path, id, autocomplete) {
    return '<div class="wz-input-row"><input type="password" id="' + id + '" data-field="' + path + '" autocomplete="' + autocomplete + '">'
      + '<button class="wz-btn" type="button" data-action="reveal" data-target="' + id + '" aria-label="Show password" aria-pressed="false">' + icon('eye', 18) + '</button></div>';
  }
  function syncPasswordReqs() {
    var p = state.password;
    var len = $('[data-req="len"]'), match = $('[data-req="match"]');
    if (len) len.classList.toggle('is-met', (p.newPw || '').length >= 4);
    if (match) match.classList.toggle('is-met', !!p.newPw && p.newPw === p.confirmPw);
    var submit = $('#pw-submit');
    if (submit && state.status && !state.status.passwordEnvManaged) submit.disabled = !(validNewPassword() && (!state.authGated || (p.setupCode || '').trim().length > 0));
  }

  function submitPassword() {
    var envManaged = state.status && state.status.passwordEnvManaged;
    var p = state.password;
    var payload;
    if (envManaged) {
      if (!state.authGated) { afterPasswordDone(); return; }
      payload = { password: p.envPw };
    } else {
      if (!validNewPassword()) {
        setGlobalError((p.newPw.length < 4) ? 'The password needs at least 4 characters.' : 'The two passwords don\'t match.');
        return;
      }
      payload = { password: p.newPw, setup_code: p.setupCode };
    }
    setBusy(true);
    var submitBtn = $('#pw-submit'); if (submitBtn) submitBtn.classList.add('is-busy');
    api('/api/wizard/password', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
      setBusy(false);
      if (submitBtn) submitBtn.classList.remove('is-busy');
      if (res.ok && res.data && res.data.success) {
        setGlobalError(null);
        afterPasswordDone();
      } else if (res.data && res.data.error) {
        setGlobalError(String(res.data.error));
      } else {
        setGlobalError('Couldn\'t save the password (error ' + res.status + '). Try again.');
      }
    }).catch(function () {
      setBusy(false);
      if (submitBtn) submitBtn.classList.remove('is-busy');
      setGlobalError('Couldn\'t reach the server to save the password.');
    });
    return true; // handled
  }

  function afterPasswordDone() {
    state.password.newPw = ''; state.password.confirmPw = '';
    state.password.setupCode = ''; state.password.envPw = '';
    if (state.authGated) {
      state.authGated = false;
      state.isReRun = false;
      state.currentStep = 2;
      setGlobalError(null);
      showStepperNav();
      revealWizard();
      loadExistingConfig().then(function () { gotoStep(2); }).catch(function () { gotoStep(2); });
      return;
    }
    markStepDone(1);
    gotoStep(2);
  }

  // ── STEP 2: SOURCES ───────────────────────────────────────
  function renderStep2() {
    var body = $('#step-2-body');
    var html = '<h2 class="wz-section-title">What do you want to connect?</h2>';
    SOURCE_GROUPS.forEach(function (g) {
      html += '<div class="wz-pick-group" role="group" aria-label="' + esc(g.label) + '"><h3 class="wz-pick-title">' + esc(g.label) + '</h3><div class="wz-pick-grid">';
      g.items.forEach(function (t) {
        var on = state.sources[t.key].selected;
        html += '<label class="wz-pick' + (on ? ' is-on' : '') + '" data-pick="' + t.key + '">'
          + '<input type="checkbox" data-source-pick="' + t.key + '"' + (on ? ' checked' : '') + '>'
          + '<span class="wz-icon-tile">' + icon(t.icon) + '</span>'
          + '<span class="wz-pick-text"><span class="wz-pick-name">' + esc(t.name) + '</span><span class="wz-pick-sub">' + esc(t.sub) + '</span></span>'
          + '<span class="wz-pick-check">' + icon('check', 14) + '</span></label>';
      });
      html += '</div></div>';
    });
    html += '<p class="wz-hint">Tuya devices and battery banks are set up in Settings after this.</p>';

    html += '<h2 class="wz-section-title">Connection details</h2>'
      + '<div class="wz-configs">'
      + '<p class="wz-configs-empty" id="sources-empty">Pick a source above and its settings appear here.</p>'
      + sourceCardDongle() + sourceCardModbusTcp() + sourceCardModbusSerial() + sourceCardRS232()
      + sourceCardBMS() + sourceCardBmsWired()
      + sourceCardHA() + sourceCardMQTT() + sourceCardREST()
      + '</div>'
      + '<div class="wz-alert is-error" id="sources-error" role="alert" hidden></div>'
      + '<div class="wz-alert is-ok" id="reset-sources-note" hidden></div>';

    if (state.isReRun) {
      html += '<p class="wz-hint" style="margin-top:28px">Want to start again? <button class="wz-btn-link is-danger" type="button" data-action="reset-sources">Clear all sources and metric roles</button></p>';
    }

    body.innerHTML = html;
    syncSourceCardVisibility();
    updateTestButtons();
    loadSourceCatalog();
  }

  // small helper to get an input value back into state when re-rendered
  function cfg(kind) { return state.sources[kind]; }

  function sourceCardHA() {
    var s = cfg('ha');
    return sourceCard('ha',
      grid(
        field('Name', inp('sources.ha.name', s.name)),
        field('Read every (seconds)', inp('sources.ha.poll_interval', s.poll_interval, { type: 'number' }))
      )
      + field('Home Assistant address', inp('sources.ha.url', s.url, { type: 'url', placeholder: 'http://192.168.1.20:8123' }))
      + field('Long-lived access token', inp('sources.ha.token', s.token, { type: 'password', placeholder: 'Paste the token', attrs: ' autocomplete="off"' }), { hint: 'In Home Assistant: your profile → Security → Long-lived access tokens → Create token.' })
      + '<div id="ha-entities"></div>');
  }
  function sourceCardMQTT() {
    var s = cfg('mqtt');
    return sourceCard('mqtt',
      grid(
        field('Name', inp('sources.mqtt.name', s.name)),
        field('Read every (seconds)', inp('sources.mqtt.poll_interval', s.poll_interval, { type: 'number' }))
      )
      + field('Broker address', inp('sources.mqtt.broker', s.broker, { placeholder: 'mqtt://192.168.1.20:1883' }))
      + grid(
        field('Username', inp('sources.mqtt.username', s.username, { attrs: ' autocomplete="off"' }), { optional: true }),
        field('Password', inp('sources.mqtt.password', s.password, { type: 'password', attrs: ' autocomplete="off"' }), { optional: true })
      )
      + '<div id="mqtt-topics"></div>',
      '<button class="wz-btn wz-btn-sm" type="button" data-action="browse-topics">' + icon('search', 16) + 'Browse topics</button>');
  }
  function sourceCardDongle() {
    var s = cfg('dongle');
    var bt = s.link === 'bluetooth';
    var serialVisible = !bt && s.profile && (s.profileRequiresSerial || s.serialVisible);
    return sourceCard('dongle',
      grid(
        field('Name', inp('sources.dongle.name', s.name)),
        field('Connection', sel('sources.dongle.link', [['network', 'WiFi or network'], ['bluetooth', 'Bluetooth']], bt ? 'bluetooth' : 'network', { id: 'dongle-link' }))
      )
      + field('Inverter profile', '<select data-field="sources.dongle.profile" id="dongle-profile"><option value="">Loading…</option></select>', { hint: 'The profile tells Epilykos how your inverter lays out its readings.' })
      + '<div id="dongle-net-group"' + (bt ? ' style="display:none;"' : '') + '>'
      + grid(
        field('IP address', inp('sources.dongle.host', s.host, { placeholder: '192.168.1.50' })),
        field('Port', inp('sources.dongle.port', s.port, { type: 'number' }))
      )
      + field('Logger serial number', inp('sources.dongle.serial_number', s.serial_number), { id: 'dongle-serial-group', hidden: !serialVisible, hint: 'Printed on the stick\'s label.' })
      + '</div>'
      + '<div class="wz-grid" id="dongle-lux-group" style="display:none;">'
      + field('Dongle serial', inp('sources.dongle.dongle_serial', s.dongle_serial, { placeholder: '10 characters' }), { hint: 'From the dongle\'s label.' })
      + field('Inverter serial', inp('sources.dongle.inverter_serial', s.inverter_serial, { placeholder: '10 characters' }), { hint: 'From the inverter\'s label.' })
      + '</div>'
      + '<div id="dongle-bt-group"' + (bt ? '' : ' style="display:none;"') + '>'
      + bleAddressField('dongle', 'sources.dongle.ble_address', s.ble_address, 'Bluetooth module')
      + '<div class="wz-grid" id="dongle-ble-uuid-row">'
      + field('Write characteristic', inp('sources.dongle.ble_write_uuid', s.ble_write_uuid, { placeholder: 'ffd1' }), { optional: true })
      + field('Notify characteristic', inp('sources.dongle.ble_notify_uuid', s.ble_notify_uuid, { placeholder: 'fff1' }), { optional: true })
      + '</div>'
      + '<p class="wz-hint" style="margin:-4px 0 16px">Close the vendor phone app first: most modules allow one connection at a time.</p>'
      + '</div>'
      + grid(
        field('Modbus unit ID', inp('sources.dongle.modbus_unit_id', s.modbus_unit_id, { type: 'number' }), { id: 'dongle-unit-group' }),
        field('Read every (seconds)', inp('sources.dongle.poll_interval', s.poll_interval, { type: 'number' }))
      )
      + field('Metric name prefix', inp('sources.dongle.prefix', s.prefix, { placeholder: 'e.g. inv1_' }), { optional: true, hint: 'Only needed with more than one inverter, so their readings get different names.' })
      + moreInvertersHtml('dongle'));
  }
  // "More inverters like this one": same profile and connection, each with its
  // own address and metric prefix. Any number; Metrics then offers to add them up.
  // Kinds of inverter source that can have more units like the first.
  var MORE_KINDS = ['dongle', 'modbusTcp', 'modbusSerial', 'rs232'];
  function firstPrefix(kind) { return kind === 'dongle' ? String(state.sources.dongle.prefix || '') : ''; }
  function extraPrefix(m, i) { return m.prefix || ('inv' + (i + 2) + '_'); }
  // The connection fields each extra unit needs; the rest is copied from the first.
  function moreConnFields(kind, s, m, base, i) {
    if (kind === 'dongle' && s.link === 'bluetooth') return field('Bluetooth address', inp(base + 'ble_address', m.ble_address, { placeholder: 'AA:BB:CC:DD:EE:FF', attrs: ' class="wz-mono" spellcheck="false"' }), { hint: 'Scan above lists every module nearby; copy this one\'s address.' });
    if (kind === 'dongle' || kind === 'modbusTcp') return '<div class="wz-grid">' + field('IP address', inp(base + 'host', m.host, { placeholder: '192.168.1.5' + (i + 1) })) + field('Port', inp(base + 'port', m.port, { type: 'number', placeholder: String(s.port || '') })) + '</div>'
      + (kind === 'modbusTcp' ? field('Unit ID', inp(base + 'unit', m.unit, { type: 'number', placeholder: String(s.unit || '1') }), { hint: 'Through one gateway? Use the same address with this unit\'s ID.' }) : '');
    if (kind === 'modbusSerial') return '<div class="wz-grid">' + field('Unit ID', inp(base + 'unit', m.unit, { type: 'number', placeholder: String(i + 2) }), { hint: 'Each unit on the RS485 line has its own ID.' })
      + field('Serial port path', inp(base + 'serial_path', m.serial_path, { placeholder: s.serial_path || '/dev/ttyUSB0' }), { optional: true, hint: 'Leave empty if it shares the port above.' }) + '</div>';
    return field('Serial port path', inp(base + 'serial_path', m.serial_path, { placeholder: '/dev/ttyUSB' + (i + 1) }), { hint: 'Each RS232 inverter needs its own port.' });
  }
  function moreInvertersHtml(kind) {
    var s = state.sources[kind], bt = kind === 'dongle' && s.link === 'bluetooth';
    var html = '<div class="wz-more" id="' + kind + '-more"><h3 class="wz-more-title">More inverters like this one</h3>';
    if (kind === 'dongle' && isLuxDongleProfile(currentDongleProfile())) return html + '<p class="wz-hint">For more LuxPower inverters, add each in Settings › Sources after setup (each needs its own serials).</p></div>';
    var what = { dongle: bt ? 'Bluetooth module' : 'dongle', modbusTcp: 'address or unit ID', modbusSerial: 'unit ID', rs232: 'serial port' }[kind];
    html += '<p class="wz-hint">Several inverters of the same kind, for example parallel units each with its own ' + what + '? Add them here. Each gets its own metric prefix so their readings stay separate.</p>';
    (s.more || []).forEach(function (m, i) {
      var base = 'sources.' + kind + '.more.' + i + '.';
      html += '<div class="wz-more-row" data-more="' + i + '">'
        + '<div class="wz-grid">' + field('Name', inp(base + 'name', m.name, { placeholder: 'Inverter ' + (i + 2) }))
        + field('Metric name prefix', inp(base + 'prefix', m.prefix, { placeholder: 'inv' + (i + 2) + '_' })) + '</div>'
        + moreConnFields(kind, s, m, base, i)
        + '<button class="wz-btn wz-btn-sm" type="button" data-action="remove-inverter" data-source="' + kind + '" data-i="' + i + '">Remove</button></div>';
    });
    // Several units on one Bluetooth adapter are read one at a time (~10 s each).
    if (bt && (s.more || []).length) {
      var units = s.more.length + 1, every = parseInt(s.poll_interval, 10) || 30, need = Math.max(30, units * 10);
      html += '<p class="wz-hint' + (every < need ? ' is-warn' : '') + '" id="dongle-bt-interval-hint">' + units + ' units on one Bluetooth adapter are read one at a time, about 10 seconds each. '
        + (every < need ? 'Set Read every to at least ' + need + ' seconds (now ' + every + ').' : 'Read every ' + every + ' seconds leaves enough time.') + '</p>';
    }
    return html + '<button class="wz-btn wz-btn-sm" type="button" data-action="add-inverter" data-source="' + kind + '">' + icon('plus', 16) + 'Add another inverter</button></div>';
  }
  // MAC input + "Scan" button + pick list, shared by the Bluetooth cards.
  function bleAddressField(kind, path, value, label) {
    return field(label,
      '<div class="wz-input-row">' + inp(path, value, { placeholder: 'AA:BB:CC:DD:EE:FF', attrs: ' class="wz-mono" spellcheck="false"' })
      + '<button class="wz-btn" type="button" data-action="ble-scan" data-source="' + kind + '">' + icon('search', 16) + 'Scan</button></div>'
      + '<div id="' + kind + '-ble-results"></div>',
      { hint: 'Scan to find it nearby, or type its address.' });
  }
  function sourceCardRS232() {
    var s = cfg('rs232');
    return sourceCard('rs232',
      grid(
        field('Name', inp('sources.rs232.name', s.name)),
        field('Inverter profile', '<select data-field="sources.rs232.profile" id="rs232-profile"><option value="">Loading…</option></select>')
      )
      + grid(
        field('Serial port', '<select data-field="sources.rs232.portChoice" id="rs232-port"><option value="">Loading…</option></select>'),
        field('Port path', inp('sources.rs232.custom_path', s.custom_path, { placeholder: '/dev/ttyUSB0' }), { id: 'rs232-custom-group', hidden: s.portChoice !== '__custom' })
      )
      + '<p class="wz-sub-divider">Serial settings · filled in from the profile</p>'
      + '<div class="wz-grid wz-grid-3">'
      + field('Baud rate', inp('sources.rs232.baud', s.baud, { type: 'number' }))
      + field('Data bits', inp('sources.rs232.data_bits', s.data_bits, { type: 'number' }))
      + field('Stop bits', inp('sources.rs232.stop_bits', s.stop_bits, { type: 'number' }))
      + field('Parity', inp('sources.rs232.parity', s.parity, { placeholder: 'none' }))
      + field('Modbus unit ID', inp('sources.rs232.modbus_unit_id', s.modbus_unit_id, { type: 'number' }))
      + field('Timeout (seconds)', inp('sources.rs232.timeout', s.timeout, { type: 'number' }))
      + '</div>'
      + moreInvertersHtml('rs232'));
  }

  var PARITY = [['none', 'None'], ['even', 'Even'], ['odd', 'Odd']];
  function modbusProfileSelect(id, kind) {
    return '<select data-field="sources.' + kind + '.profile" id="' + id + '"><option value="">Loading…</option></select>';
  }

  function sourceCardModbusSerial() {
    var s = cfg('modbusSerial');
    return sourceCard('modbusSerial',
      grid(
        field('Name', inp('sources.modbusSerial.name', s.name)),
        field('Inverter profile', modbusProfileSelect('modbus-serial-profile', 'modbusSerial'))
      )
      + field('Serial port path', inp('sources.modbusSerial.serial_path', s.serial_path, { placeholder: '/dev/ttyUSB0' }))
      + '<div class="wz-grid wz-grid-3">'
      + field('Baud rate', inp('sources.modbusSerial.serial_baud', s.serial_baud, { type: 'number' }))
      + field('Data bits', inp('sources.modbusSerial.serial_data_bits', s.serial_data_bits, { type: 'number' }))
      + field('Stop bits', inp('sources.modbusSerial.serial_stop_bits', s.serial_stop_bits, { type: 'number' }))
      + field('Parity', sel('sources.modbusSerial.serial_parity', PARITY, s.serial_parity))
      + field('Unit ID', inp('sources.modbusSerial.unit', s.unit, { type: 'number' }))
      + field('Read every (seconds)', inp('sources.modbusSerial.poll_interval', s.poll_interval, { type: 'number' }))
      + '</div>'
      + moreInvertersHtml('modbusSerial'));
  }
  function sourceCardModbusTcp() {
    var s = cfg('modbusTcp');
    return sourceCard('modbusTcp',
      grid(
        field('Name', inp('sources.modbusTcp.name', s.name)),
        field('Inverter profile', modbusProfileSelect('modbus-tcp-profile', 'modbusTcp'))
      )
      + grid(
        field('IP address', inp('sources.modbusTcp.host', s.host, { placeholder: '192.168.1.50' })),
        field('Port', inp('sources.modbusTcp.port', s.port, { type: 'number', placeholder: '502' }))
      )
      + field('Gateway type', sel('sources.modbusTcp.tcp_framing', [['tcp', 'Converts to Modbus-TCP (most gateways)'], ['rtu', 'Transparent (RTU over TCP)']], s.tcp_framing === 'rtu' ? 'rtu' : 'tcp'),
        { id: 'modbus-tcp-gateway', hidden: true, hint: 'This inverter has an RS485 port, so it\'s reached through an RS485-to-network gateway such as an Elfin EW11 or USR-TCP232.' })
      + grid(
        field('Unit ID', inp('sources.modbusTcp.unit', s.unit, { type: 'number' })),
        field('Read every (seconds)', inp('sources.modbusTcp.poll_interval', s.poll_interval, { type: 'number' }))
      )
      + moreInvertersHtml('modbusTcp'));
  }
  function sourceCardBMS() {
    var s = cfg('bms');
    return sourceCard('bms',
      grid(
        field('Name', inp('sources.bms.name', s.name)),
        field('Read every (seconds)', inp('sources.bms.poll_interval', s.poll_interval, { type: 'number' }))
      )
      + bleAddressField('bms', 'sources.bms.address', s.address, 'Battery')
      + '<p class="wz-hint" style="margin-top:-4px">Close the battery\'s phone app first: most BMS allow one connection at a time.</p>');
  }
  function sourceCardBmsWired() {
    var s = cfg('bmsWired');
    return sourceCard('bmsWired',
      grid(
        field('Name', inp('sources.bmsWired.name', s.name)),
        field('Read every (seconds)', inp('sources.bmsWired.poll_interval', s.poll_interval, { type: 'number' }))
      )
      + grid(
        field('Serial port', '<select data-field="sources.bmsWired.serial_path" id="bms-wired-port"><option value="">Loading…</option></select>'),
        field('BMS profile', '<select data-field="sources.bmsWired.profile" id="bms-wired-profile"><option value="">Loading…</option></select>')
      )
      + '<div class="wz-profile-notes" id="bms-wired-profile-notes" style="display:none;"></div>'
      + '<p class="wz-sub-divider">Serial settings · filled in from the profile</p>'
      + '<div class="wz-grid wz-grid-3">'
      + field('Baud rate', inp('sources.bmsWired.baud', s.baud, { type: 'number' }))
      + field('Data bits', sel('sources.bmsWired.data_bits', [['8', '8'], ['7', '7'], ['6', '6'], ['5', '5']], s.data_bits))
      + field('Stop bits', sel('sources.bmsWired.stop_bits', [['1', '1'], ['2', '2']], s.stop_bits))
      + field('Parity', sel('sources.bmsWired.parity', PARITY, s.parity))
      + field('Modbus unit ID', inp('sources.bmsWired.modbus_unit_id', s.modbus_unit_id, { type: 'number' }), { id: 'bms-wired-unit-group' })
      + field('Timeout (ms)', inp('sources.bmsWired.timeout', s.timeout, { type: 'number' }))
      + '</div>');
  }
  function sourceCardREST() {
    var s = cfg('rest');
    return sourceCard('rest',
      field('Name', inp('sources.rest.name', s.name))
      + field('Endpoint URL', inp('sources.rest.url', s.url, { type: 'url', placeholder: 'https://api.example.com/v1/data' }))
      + field('JSON path to try', '<input id="rest-test-jsonpath" placeholder="e.g. current.temp_c">', { optional: true, hint: 'Only used by Test connection. Choose which values become metrics in Settings → Sources after setup.' }));
  }
  function syncSourceCardVisibility() {
    var any = false;
    $$('.source-config').forEach(function (card) {
      var key = card.getAttribute('data-source');
      var on = !!state.sources[key].selected;
      any = any || on;
      card.classList.toggle('visible', on);
      if (!on) { clearBadge(key); clearError(key); }
    });
    $$('[data-source-pick]').forEach(function (cb) {
      var on = !!state.sources[cb.getAttribute('data-source-pick')].selected;
      cb.checked = on;
      cb.closest('.wz-pick').classList.toggle('is-on', on);
    });
    var empty = $('#sources-empty'); if (empty) empty.hidden = any;
  }

  // load dongle profiles + rs232 ports/profiles once
  function loadSourceCatalog() {
    if (state.sources.dongle.selected && !state.sources.dongle.profilesLoaded) loadDongleProfiles();
    if (state.sources.rs232.selected && !state.sources.rs232.profilesLoaded) loadRs232Ports();
    if (state.sources.rs232.selected && !state.sources.rs232.profilesLoaded) loadRs232Profiles();
    if (state.sources.modbusSerial.selected && !state.sources.modbusSerial.profilesLoaded) loadModbusProfiles('modbusSerial', 'modbus-serial-profile');
    if (state.sources.modbusTcp.selected && !state.sources.modbusTcp.profilesLoaded) loadModbusProfiles('modbusTcp', 'modbus-tcp-profile');
    if (state.sources.bmsWired.selected) { loadBmsWiredPorts(); loadBmsWiredProfiles(); }
  }

  function loadModbusProfiles(kind, selId) {
    state.sources[kind].profilesLoaded = true;
    api('/api/modbus/profiles').then(function (res) {
      var sel = docById(selId);
      if (!res.ok || !Array.isArray(res.data)) {
        if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
        return;
      }
      state.sources[kind].profiles = res.data;
      if (!sel) return;
      var cur = state.sources[kind].profile;
      function opt(p) { return '<option value="' + esc(p.id) + '"' + (cur === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }
      var tcpNative = res.data.filter(function (p) { return p.connection === 'tcp'; });
      var rtu = res.data.filter(function (p) { return p.connection !== 'tcp'; });
      var html = '<option value="">Select a profile…</option>';
      if (kind === 'modbusTcp') {
        // Modbus-TCP devices first; RS-485 inverters need a gateway.
        if (tcpNative.length) html += '<optgroup label="Modbus-TCP devices">' + tcpNative.map(opt).join('') + '</optgroup>';
        if (rtu.length) html += '<optgroup label="RS-485 inverters (via RS485-to-Ethernet gateway)">' + rtu.map(opt).join('') + '</optgroup>';
      } else {
        html += rtu.map(opt).join(''); // Modbus-TCP-only devices cannot be wired over RS-485
      }
      sel.innerHTML = html;
      if (kind === 'modbusTcp') syncModbusGateway();
      if (state.sources[kind].profile) loadProfileEntities(kind);
    }).catch(function () {
      var sel = docById(selId);
      if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
    });
  }
  function docById(id) { return document.getElementById(id); }
  function syncModbusGateway() {
    var t = state.sources.modbusTcp;
    var p = (t.profiles || []).filter(function (x) { return x.id === t.profile; })[0];
    var g = docById('modbus-tcp-gateway');
    if (g) g.style.display = (p && p.connection !== 'tcp') ? '' : 'none';
  }

  function loadDongleProfiles() {
    state.sources.dongle.profilesLoaded = true;
    api('/api/dongle/profiles').then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) {
        var sel = $('#dongle-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
        return;
      }
      var d = state.sources.dongle;
      d.profiles = res.data;
      // Older wizard runs saved the display name; the poller needs the file id.
      var byName = res.data.filter(function (p) { return p.name === d.profile; })[0];
      if (byName) d.profile = byName.id;
      renderDongleProfileOptions();
      if (d.profile) onDongleProfileChange(d.profile, false);
    }).catch(function () {
      var sel = $('#dongle-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
    });
  }
  // Bluetooth modules speak Modbus, so only register-map profiles apply there.
  function isRegisterDongleProfile(p) {
    var protocol = String(p.protocol || '').toLowerCase();
    return protocol !== 'luxpower-tcp' && protocol !== 'felicity-tcp' && protocol !== 'ble-gatt' && String(p.transport || '').toLowerCase() !== 'growatt';
  }
  // Read-only Bluetooth devices that publish values directly (e.g. Phocos Any-Grid).
  function isBluetoothOnlyProfile(p) { return !!p && (isBleGattDongleProfile(p) || p.connection === 'bluetooth'); }
  function isBleGattDongleProfile(p) { return !!p && String(p.protocol || '').toLowerCase() === 'ble-gatt'; }
  // LuxPower dongles: same frames over Wi-Fi (TCP 8000) or Bluetooth, addressed by dongle + inverter serial.
  function isLuxDongleProfile(p) { return !!p && String(p.protocol || '').toLowerCase() === 'luxpower-tcp'; }
  function currentDongleProfile() {
    var d = state.sources.dongle;
    return (d.profiles || []).filter(function (p) { return p.id === d.profile; })[0];
  }
  function renderDongleProfileOptions() {
    var d = state.sources.dongle;
    var sel = $('#dongle-profile');
    if (!sel || !d.profiles) return;
    var bt = d.link === 'bluetooth';
    var html = '<option value="">Select a profile…</option>';
    var btOnly = '';
    d.profiles.forEach(function (p) {
      if (bt && !isRegisterDongleProfile(p) && !isBleGattDongleProfile(p) && !isLuxDongleProfile(p)) return;
      var opt = '<option value="' + esc(p.id) + '"' + (d.profile === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      // On WiFi, Bluetooth-only profiles (e.g. Phocos Any-Grid) are still
      // listed in their own group; picking one switches to Bluetooth.
      if (!bt && isBluetoothOnlyProfile(p)) btOnly += opt; else html += opt;
    });
    if (btOnly) html += '<optgroup label="Bluetooth only">' + btOnly + '</optgroup>';
    sel.innerHTML = html;
    if (d.profile && sel.value !== d.profile) { d.profile = ''; d.mappings = {}; d.entities = []; }
  }
  function syncDongleLink() {
    var d = state.sources.dongle;
    var bt = d.link === 'bluetooth';
    var net = $('#dongle-net-group'); if (net) net.style.display = bt ? 'none' : '';
    var btg = $('#dongle-bt-group'); if (btg) btg.style.display = bt ? '' : 'none';
    renderDongleProfileOptions();
    d.transport = dongleTransport();
    syncDongleBleFields();
  }
  // Characteristics / unit id only apply to Modbus over BLE; LuxPower needs its two serials instead.
  function syncDongleBleFields() {
    var prof = currentDongleProfile();
    var lux = isLuxDongleProfile(prof);
    var own = (state.sources.dongle.link === 'bluetooth' && isBleGattDongleProfile(prof)) || lux;
    var uuid = $('#dongle-ble-uuid-row'); if (uuid) uuid.style.display = own ? 'none' : '';
    var unit = $('#dongle-unit-group'); if (unit) unit.style.display = own ? 'none' : '';
    var luxg = $('#dongle-lux-group'); if (luxg) luxg.style.display = lux ? '' : 'none';
  }
  function dongleTransport() {
    var d = state.sources.dongle;
    if (d.link === 'bluetooth') {
      var bp = currentDongleProfile();
      return isBleGattDongleProfile(bp) ? 'ble-gatt' : isLuxDongleProfile(bp) ? 'ble-luxpower' : 'ble-modbus';
    }
    var prof = (d.profiles || []).filter(function (p) { return p.id === d.profile; })[0];
    if (!prof) return /^ble-/.test(d.transport || '') ? 'solarman-v5' : (d.transport || 'solarman-v5');
    if (prof.protocol === 'felicity-tcp') return 'felicity-tcp';
    if (prof.protocol === 'luxpower-tcp') return 'luxpower-tcp';
    return prof.transport || 'solarman-v5';
  }

  function loadRs232Ports() {
    state.sources.rs232.portsLoaded = true;
    api('/api/rs232/ports').then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) {
        var sel = $('#rs232-port'); if (sel) sel.innerHTML = '<option value=""></option><option value="__custom">No ports — use a custom path…</option>';
        return;
      }
      state.sources.rs232.ports = res.data;
      var sel = $('#rs232-port');
      if (sel) {
        var html = '<option value="">Select a port…</option>';
        res.data.forEach(function (p) {
          var v = p.path;
          var label = p.friendlyName ? (p.friendlyName + ' (' + p.path + ')') : p.path;
          html += '<option value="' + esc(v) + '"' + (state.sources.rs232.portChoice === v ? ' selected' : '') + '>' + esc(label) + '</option>';
        });
        html += '<option value="__custom"' + (state.sources.rs232.portChoice === '__custom' ? ' selected' : '') + '>Custom path…</option>';
        sel.innerHTML = html;
        syncCustomGroup();
      }
    }).catch(function () {
      var sel = $('#rs232-port'); if (sel) sel.innerHTML = '<option value=""></option><option value="__custom">No ports — use a custom path…</option>';
    });
  }

  function loadRs232Profiles() {
    state.sources.rs232.profilesLoaded = true;
    api('/api/rs232/profiles').then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) {
        var sel = $('#rs232-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
        return;
      }
      state.sources.rs232.profiles = res.data;
      var sel = $('#rs232-profile');
      if (sel) {
        var html = '<option value="">Select a profile…</option>';
        res.data.forEach(function (p) {
          var hay = String(p.name || '') + ' ' + String(p.id || '');
          if (hay.toLowerCase().indexOf('bms') !== -1) return;
          if (p.name === state.sources.rs232.profile) state.sources.rs232.profile = p.id; // legacy: saved by name
          html += '<option value="' + esc(p.id) + '"' + (state.sources.rs232.profile === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
        });
        sel.innerHTML = html;
        if (state.sources.rs232.profile) onRs232ProfileChange(state.sources.rs232.profile, false);
      }
    }).catch(function () {
      var sel = $('#rs232-profile'); if (sel) sel.innerHTML = '<option value="">(unavailable)</option>';
    });
  }

  function loadBmsWiredPorts() {
    api('/api/rs232/ports').then(function (res) {
      var sel = $('#bms-wired-port');
      if (!sel) return;
      if (!res.ok || !Array.isArray(res.data)) {
        sel.innerHTML = '<option value="">Ports unavailable</option>';
        return;
      }
      var html = '<option value="">-- Select port --</option>';
      res.data.forEach(function (p) {
        var v = p.path;
        var label = p.friendlyName ? (p.friendlyName + ' (' + p.path + ')') : p.path;
        html += '<option value="' + esc(v) + '"' + (state.sources.bmsWired.serial_path === v ? ' selected' : '') + '>' + esc(label) + '</option>';
      });
      sel.innerHTML = html;
    }).catch(function () {
      var sel = $('#bms-wired-port');
      if (sel) sel.innerHTML = '<option value="">Ports unavailable</option>';
    });
  }

  function updateBmsWiredProfileNotes() {
    var sel = $('#bms-wired-profile');
    var box = $('#bms-wired-profile-notes');
    if (!sel || !box) return;
    var descriptions = {};
    try { descriptions = JSON.parse(sel.dataset.descriptions || '{}'); } catch (e) { descriptions = {}; }
    var text = descriptions[sel.value] || '';
    if (text) {
      box.textContent = text;
      box.style.display = '';
    } else {
      box.textContent = '';
      box.style.display = 'none';
    }
  }

  function loadBmsWiredProfiles() {
    api('/api/rs232/profiles').then(function (res) {
      var sel = $('#bms-wired-profile');
      if (!sel) return;
      if (!res.ok || !Array.isArray(res.data)) {
        sel.innerHTML = '<option value="">Profiles unavailable</option>';
        return;
      }
      var html = '<option value="">Select a profile…</option>';
      var found = false;
      var descriptions = {};
      res.data.forEach(function (p) {
        var id = p.id !== undefined && p.id !== null ? p.id : p.name;
        var name = p.name || id;
        var hay = String(name).toLowerCase() + ' ' + String(id).toLowerCase();
        if (hay.indexOf('bms') === -1) return;
        // Unverified skeleton maps stay out of the wizard (a saved device keeps its choice).
        if (p.placeholder && state.sources.bmsWired.profile !== id) return;
        found = true;
        state.sources.bmsWired.profileInfo = state.sources.bmsWired.profileInfo || {};
        state.sources.bmsWired.profileInfo[id] = p;
        descriptions[id] = p.description || '';
        html += '<option value="' + esc(id) + '"' + (state.sources.bmsWired.profile === id ? ' selected' : '') + '>' + esc(name) + '</option>';
      });
      if (!found) html = '<option value="">No BMS profiles found</option>';
      sel.innerHTML = html;
      sel.dataset.descriptions = JSON.stringify(descriptions);
      updateBmsWiredProfileNotes();
      if (state.sources.bmsWired.profile) { loadBmsWiredFields(); applyBmsWiredProfile(false); }
    }).catch(function () {
      var sel = $('#bms-wired-profile');
      if (sel) sel.innerHTML = '<option value="">Profiles unavailable</option>';
    });
  }

  function syncCustomGroup() {
    var g = $('#rs232-custom-group');
    if (g) g.style.display = (state.sources.rs232.portChoice === '__custom') ? '' : 'none';
  }

  // userChange: the user picked a different profile, so saved mappings (which
  // point at the old profile's registers) are dropped and rebuilt from the new one.
  function onDongleProfileChange(id, userChange) {
    var d = state.sources.dongle;
    var prof = (d.profiles || []).filter(function (p) { return p.id === id; })[0];
    if (userChange) { d.mappings = {}; d.entities = []; }
    if (prof && isBluetoothOnlyProfile(prof) && d.link !== 'bluetooth') {
      setFieldValue('sources.dongle.link', 'bluetooth');
      syncDongleLink();
    }
    if (prof) {
      d.transport = dongleTransport();
      syncDongleBleFields();
      if (userChange && prof.default_poll_interval) setFieldValue('sources.dongle.poll_interval', prof.default_poll_interval);
      if (userChange && d.link !== 'bluetooth' && prof.default_port != null) setFieldValue('sources.dongle.port', prof.default_port);
      if (userChange && prof.default_unit_id != null) setFieldValue('sources.dongle.modbus_unit_id', prof.default_unit_id);
      d.profileRequiresSerial = !!prof.requires_serial;
      var g = $('#dongle-serial-group');
      if (g) g.style.display = (d.profileRequiresSerial && d.link !== 'bluetooth') ? '' : 'none';
      if (state.sources.dongle.profileMetricsLoadedFor !== id) ensureDongleProfileDetail(id);
      loadProfileEntities('dongle');
    }
  }

  function onRs232ProfileChange(id, userChange) {
    var r = state.sources.rs232;
    var prof = (r.profiles || []).filter(function (p) { return p.id === id; })[0];
    if (userChange) { r.mappings = {}; r.entities = []; }
    if (prof) {
      loadProfileEntities('rs232');
      var defaults = prof.defaults || {};
      if (defaults.baud != null) setFieldValue('sources.rs232.baud', defaults.baud);
      if (defaults.dataBits != null) setFieldValue('sources.rs232.data_bits', defaults.dataBits);
      if (defaults.stopBits != null) setFieldValue('sources.rs232.stop_bits', defaults.stopBits);
      if (defaults.parity != null) setFieldValue('sources.rs232.parity', defaults.parity);
      if (prof.default_unit_id != null) setFieldValue('sources.rs232.modbus_unit_id', prof.default_unit_id);
      if (state.sources.rs232.profileMetricsLoadedFor !== id) ensureRs232ProfileDetail(id);
    }
  }

  function setFieldValue(path, value) {
    setPath(state, path, value);
    var el = document.querySelector('[data-field="' + path + '"]');
    if (el && String(el.value) !== String(value)) { el.value = value; }
  }

  // Entity catalog for the chosen profile: [{id: decode handle, name: default
  // metric name}]. The wizard turns it into default mappings so a source set up
  // here writes metrics (an empty mappings object means "write nothing").
  var ENTITY_URL = { dongle: '/api/dongle/profile/', rs232: '/api/rs232/profile/', modbusSerial: '/api/modbus/profile/', modbusTcp: '/api/modbus/profile/' };
  function loadProfileEntities(kind) {
    var src = state.sources[kind];
    var id = src.profile;
    if (!id || src.entitiesFor === id) return;
    api(ENTITY_URL[kind] + encodeURIComponent(id) + '/entities').then(function (res) {
      if (src.profile !== id) return;
      src.entities = (res.ok && Array.isArray(res.data)) ? res.data : [];
      src.entitiesFor = id;
      if (state.currentStep === 3) renderStep3();
    }).catch(function () {});
  }
  // Serial settings follow the chosen wired profile (JK = 115200); JBD / JK are
  // not Modbus, so their unit id is hidden.
  function applyBmsWiredProfile(userChange) {
    var w = state.sources.bmsWired;
    var p = (w.profileInfo || {})[w.profile];
    var g = $('#bms-wired-unit-group');
    if (g) {
      g.style.display = (p && ['jbd', 'jk-rs485'].indexOf(p.protocol) >= 0) ? 'none' : '';
      var lbl = g.querySelector('label');
      if (lbl) lbl.textContent = (p && p.protocol === 'pace-v25') ? 'Pack address (DIP switch)' : 'Modbus unit id';
    }
    if (!userChange || !p || !p.defaults) return;
    var d = p.defaults;
    if (d.baud != null) setFieldValue('sources.bmsWired.baud', d.baud);
    if (d.dataBits != null) setFieldValue('sources.bmsWired.data_bits', d.dataBits);
    if (d.parity != null) setFieldValue('sources.bmsWired.parity', d.parity);
    if (d.stopBits != null) setFieldValue('sources.bmsWired.stop_bits', d.stopBits);
  }
  function loadBmsWiredFields() {
    var w = state.sources.bmsWired;
    if (!w.profile) { w.fieldKeys = []; return; }
    api('/api/bms-wired/fields/' + encodeURIComponent(w.profile)).then(function (res) {
      w.fieldKeys = (res.ok && Array.isArray(res.data)) ? res.data.map(function (f) { return f.field; }).filter(Boolean) : [];
    }).catch(function () {});
  }
  // Mappings to save for a register/field source: what the user already has,
  // else one metric per profile entity (same as Settings' "Load Profile Registers").
  function effectiveMappings(kind) {
    var src = state.sources[kind];
    if (src.mappings && Object.keys(src.mappings).length) return src.mappings;
    var prefix = kind === 'dongle' ? (src.prefix || '') : '';
    var out = {};
    (src.entities || []).forEach(function (e) {
      if (!e || e.id === undefined || e.id === null || !e.name) return;
      var metric = prefix + e.name;
      if (out[metric] === undefined) out[metric] = String(e.id);
    });
    return out;
  }
  function bmsMetricName(deviceName, key) {
    return ('bms_' + deviceName + '_' + key).replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function ensureDongleProfileDetail(id) {
    api('/api/dongle/profile/' + encodeURIComponent(id)).then(function (res) {
      if (res.ok && res.data) {
        state.sources.dongle.profileMetrics = res.data.metrics || [];
        state.sources.dongle.profileMetricsLoadedFor = id;
        if (state.currentStep === 3) renderStep3(); // refresh auto-fill
      }
    }).catch(function () {});
  }
  function ensureRs232ProfileDetail(id) {
    api('/api/rs232/profile/' + encodeURIComponent(id)).then(function (res) {
      if (res.ok && res.data) {
        state.sources.rs232.profileMetrics = res.data.metrics || [];
        state.sources.rs232.profileMetricsLoadedFor = id;
        if (state.currentStep === 3) renderStep3();
      }
    }).catch(function () {});
  }

  // ── Bluetooth scan (BMS + inverter Bluetooth modules) ─────
  var BLE_FIELD = { bms: 'sources.bms.address', dongle: 'sources.dongle.ble_address' };
  function runBleScan(kind, btn) {
    var box = $('#' + kind + '-ble-results');
    if (!box) return;
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    box.innerHTML = '<p class="wz-hint" style="margin-top:8px">Scanning for Bluetooth devices. This takes about 10 seconds…</p>';
    // BMS: recognised batteries first; inverter modules: everything nearby.
    var url = kind === 'bms' ? '/api/bms/scan?force=1' : '/api/bluetooth/scan';
    api(url).then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) {
        box.innerHTML = alertBox('error', esc(apiErrMsg(res, 'Bluetooth scan')));
        return;
      }
      if (!res.data.length) {
        box.innerHTML = alertBox('info', 'Nothing found. Check the device is powered, within about 10 m, and not connected to a phone app, then scan again.');
        return;
      }
      var rows = res.data.slice().sort(function (a, b) { return (b.rssi || -999) - (a.rssi || -999); }).map(function (d) {
        var tag = d.bms_type ? '<span class="wz-tag">' + esc(d.bms_type) + '</span>' : '';
        return '<button type="button" class="wz-list-item" data-action="ble-pick" data-source="' + esc(kind) + '" data-address="' + esc(d.address) + '">'
          + '<span class="wz-name">' + esc(d.name || 'Unknown device') + '</span>' + tag
          + '<code>' + esc(d.address) + '</code><span class="wz-rssi">' + esc(String(d.rssi)) + ' dBm</span></button>';
      }).join('');
      box.innerHTML = '<div class="wz-list-head"><span class="wz-label">' + res.data.length + ' found · strongest signal first</span></div><div class="wz-list">' + rows + '</div>';
    }).catch(function () {
      box.innerHTML = alertBox('error', 'Network error during the Bluetooth scan.');
    }).then(function () { if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); } });
  }
  function pickBleDevice(kind, address) {
    setFieldValue(BLE_FIELD[kind], address);
    var box = $('#' + kind + '-ble-results');
    if (box) box.innerHTML = '<p class="wz-hint" style="margin-top:8px">Using ' + esc(address) + '. Press Test connection to check it.</p>';
    clearBadge(kind);
    clearError(kind);
    updateTestButtons();
    updateNav();
  }

  // ── Connection tests ──────────────────────────────────────
  // Status pill on a source/extras card. cls: 'pending' (grey, or a spinner
  // while the text ends in "…"), 'ok' or 'fail'.
  function setBadge(key, cls, text) {
    var el = document.querySelector('[data-badge-src="' + key + '"]');
    if (!el) return;
    var tone = cls === 'ok' ? ' is-ok' : cls === 'fail' ? ' is-error' : (/…$/.test(text) ? ' is-busy' : '');
    el.className = 'wz-pill' + tone;
    el.textContent = text;
    el.hidden = false;
  }
  function clearBadge(key) { setBadge(key, 'pending', 'Not tested'); }
  function setError(key, msg) {
    var el = document.querySelector('[data-error="' + key + '"]');
    if (el) { el.className = 'wz-alert is-error'; el.setAttribute('role', 'alert'); el.textContent = msg; }
  }
  function clearError(key) {
    var el = document.querySelector('[data-error="' + key + '"]');
    if (el) { el.className = ''; el.removeAttribute('role'); el.innerHTML = ''; }
  }

  function hasMinimal(kind) {
    var s = state.sources[kind];
    if (kind === 'ha') return !!(s.url && s.token);
    if (kind === 'mqtt') return !!s.broker;
    if (kind === 'dongle') return s.link === 'bluetooth' ? !!(s.ble_address && s.profile) : !!(s.host && s.port && s.profile);
    if (kind === 'rs232') return !!(resolveSerialPath(s) && s.profile);
    if (kind === 'modbusSerial') return !!(s.serial_path && s.transport === 'serial');
    if (kind === 'modbusTcp') return !!(s.host && s.port && s.transport === 'tcp');
    if (kind === 'bms') return !!s.address;
    if (kind === 'bmsWired') return !!(s.serial_path && s.profile && s.modbus_unit_id);
    if (kind === 'rest') return !!s.url;
    return false;
  }
  function resolveSerialPath(s) {
    s = s || state.sources.rs232;
    return (s.portChoice === '__custom') ? (s.custom_path || '') : (s.portChoice || '');
  }

  function updateTestButtons() {
    $$('[data-action="test"]').forEach(function (btn) {
      var src = btn.getAttribute('data-source');
      // Optional-step test buttons (pvoutput/forecast/network) are always enabled.
      if (!state.sources[src]) { btn.disabled = false; return; }
      btn.disabled = !state.sources[src].selected || !hasMinimal(src);
    });
    var browse = $('[data-action="browse-topics"]');
    if (browse) browse.disabled = !state.sources.mqtt.selected || !hasMinimal('mqtt');
  }

  function runTest(kind) {
    var s = state.sources[kind];
    setBadge(kind, 'pending', 'Testing…');
    var testBtn = document.querySelector('[data-action="test"][data-source="' + kind + '"]');
    if (testBtn) testBtn.classList.add('is-busy');
    clearError(kind);
    var p;
    if (kind === 'ha') {
      p = api('/api/ha-device-entities', { method: 'POST', body: JSON.stringify({ url: s.url, token: s.token }) });
    } else if (kind === 'mqtt') {
      p = api('/api/test-mqtt', { method: 'POST', body: JSON.stringify({ broker: s.broker, username: s.username, password: s.password }) });
    } else if (kind === 'dongle') {
      var body = dongleTestBody();
      p = api('/api/dongle/test', { method: 'POST', body: JSON.stringify(body) });
    } else if (kind === 'rs232') {
      p = api('/api/test-rs232', { method: 'POST', body: JSON.stringify(buildRS232Device()) });
    } else if (kind === 'modbusSerial' || kind === 'modbusTcp') {
      var mb = modbusTestBody(kind);
      p = api('/api/test-modbus', { method: 'POST', body: JSON.stringify(mb) });
    } else if (kind === 'bms') {
      p = api('/api/bms/test' + encodeQuery({ address: s.address }));
    } else if (kind === 'bmsWired') {
      p = api('/api/bms-wired/test', { method: 'POST', body: JSON.stringify({ serial_path: s.serial_path, baud: s.baud, data_bits: s.data_bits, parity: s.parity, stop_bits: s.stop_bits, modbus_unit_id: s.modbus_unit_id, profile: s.profile, timeout: s.timeout }) });
    } else if (kind === 'rest') {
      var jpEl = document.getElementById('rest-test-jsonpath');
      var jsonPath = jpEl ? jpEl.value : '';
      p = api('/api/test-external', { method: 'POST', body: JSON.stringify({ url: s.url, jsonPath: jsonPath }) });
    } else if (kind === 'pvoutput') {
      var pvo = state.optional.pvoutput;
      p = api('/api/pvoutput/test', { method: 'POST', body: JSON.stringify({ api_key: pvo.api_key, system_id: pvo.system_id }) });
    } else if (kind === 'forecast') {
      var fo = state.optional.forecast;
      p = api('/api/test-forecast', { method: 'POST', body: JSON.stringify(compact({ lat: fo.latitude, lon: fo.longitude, capacity: state.basics.solar_capacity_kwp, api_key: fo.solcast_api_key, resource_id: fo.solcast_resource_id, tilt: fo.tilt, azimuth: fo.azimuth, loss: fo.loss_factor })) });
    } else if (kind === 'network') {
      p = testNetworkUrls();
    }
    if (!p) return;
    p = p.then(function (res) { if (testBtn) testBtn.classList.remove('is-busy'); return res; }, function (e) { if (testBtn) testBtn.classList.remove('is-busy'); throw e; });
    p.then(function (res) {
      if (kind === 'ha') {
        if (res.ok && Array.isArray(res.data)) {
          state.sources.ha.entities = res.data;
          setBadge('ha', 'ok', res.data.length + ' entities');
          renderHAEntities(res.data);
        } else {
          var msg = apiErrMsg(res, 'HA');
          setBadge('ha', 'fail', 'Failed');
          setError('ha', msg);
        }
      } else if (kind === 'mqtt') {
        if (res.ok && res.data && res.data.success !== false) {
          setBadge('mqtt', 'ok', 'Connected');
        } else {
          setBadge('mqtt', 'fail', 'Failed');
          setError('mqtt', apiErrMsg(res, 'MQTT'));
        }
      } else if (kind === 'dongle') {
        if (res.ok && res.data && res.data.success) {
          setBadge('dongle', 'ok', 'Connected');
        } else {
          setBadge('dongle', 'fail', 'Failed');
          setError('dongle', apiErrMsg(res, 'Inverter'));
        }
      } else if (kind === 'rs232') {
        if (res.ok && res.data && res.data.success) {
          setBadge('rs232', 'ok', 'Connected');
        } else {
          setBadge('rs232', 'fail', 'Failed');
          setError('rs232', apiErrMsg(res, 'RS232'));
        }
      } else if (kind === 'modbusSerial' || kind === 'modbusTcp') {
        if (res.ok && res.data && res.data.success !== false) {
          setBadge(kind, 'ok', 'Connected');
        } else {
          setBadge(kind, 'fail', 'Failed');
          setError(kind, apiErrMsg(res, 'Modbus'));
        }
      } else if (kind === 'bms') {
        var bmsKeys = (res.ok && res.data && typeof res.data === 'object') ? Object.keys(res.data).filter(function (k) { return typeof res.data[k] === 'number'; }) : [];
        if (bmsKeys.length) {
          state.sources.bms.sampleKeys = bmsKeys;
          setBadge('bms', 'ok', bmsKeys.length + ' readings');
        } else {
          setBadge('bms', 'fail', 'Failed');
          setError('bms', apiErrMsg(res, 'BMS'));
        }
      } else if (kind === 'bmsWired') {
        if (res.ok && res.data && Object.keys(res.data || {}).length) {
          state.sources.bmsWired.sampleKeys = Object.keys(res.data);
          setBadge('bmsWired', 'ok', Object.keys(res.data).length + ' readings');
        } else {
          setBadge('bmsWired', 'fail', 'Failed');
          setError('bmsWired', apiErrMsg(res, 'Wired BMS'));
        }
      } else if (kind === 'rest') {
        if (res.ok) {
          setBadge('rest', 'ok', 'Reachable');
        } else {
          setBadge('rest', 'fail', 'Failed');
          setError('rest', apiErrMsg(res, 'REST'));
        }
      } else if (kind === 'pvoutput') {
        if (res.ok && res.data && res.data.success) {
          setBadge('pvoutput', 'ok', 'Connected');
        } else {
          setBadge('pvoutput', 'fail', 'Failed');
          setError('pvoutput', apiErrMsg(res, 'PVOutput'));
        }
      } else if (kind === 'forecast') {
        if (res.ok && res.data && res.data.source) {
          setBadge('forecast', 'ok', res.data.source + ' · ' + res.data.today_estimate_kwh + ' kWh today');
        } else {
          setBadge('forecast', 'fail', 'Failed');
          setError('forecast', apiErrMsg(res, 'Forecast'));
        }
      } else if (kind === 'network') {
        if (res.ok && res.data) {
          var lr = res.data.localReachable;
          var rr = res.data.remoteReachable;
          setBadge('network', (lr || rr) ? 'ok' : 'fail',
            (lr ? 'Local OK' : 'Local unreachable') + ' · ' + (rr ? 'Remote OK' : 'Remote unreachable'));
          if (!lr && !rr) setError('network', 'None of the configured URLs were reachable.');
        } else {
          setBadge('network', 'fail', 'Failed');
          setError('network', apiErrMsg(res, 'Network'));
        }
      }
    }).catch(function (e) {
      setBadge(kind, 'fail', 'Failed');
      setError(kind, 'Network error during the test.');
    });
  }

  // Probe whether a base URL is reachable, without CORS/status concerns.
  // Mirrors public/js/network-detect.js checkLocalReachable(): a small static
  // asset is enough — a reachable server that answers must set onload.
  function probeUrl(baseURL) {
    if (!baseURL) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var img = new Image();
      var timer = setTimeout(function () { img.src = ''; resolve(false); }, 4000);
      img.onload = function () { clearTimeout(timer); resolve(true); };
      img.onerror = function () { clearTimeout(timer); resolve(false); };
      img.src = baseURL.replace(/\/+$/, '') + '/icons/icon-192.png?' + Date.now();
    });
  }

  function testNetworkUrls() {
    var nw = state.optional.network;
    if (!nw.local_url && !nw.remote_url) {
      return Promise.resolve({ ok: false, status: 0, data: { localReachable: false, remoteReachable: false } });
    }
    return Promise.all([probeUrl(nw.local_url), probeUrl(nw.remote_url)]).then(function (r) {
      return { ok: true, status: 200, data: { localReachable: r[0], remoteReachable: r[1] } };
    });
  }

  function modbusTestBody(kind) {
    if (kind === 'modbusTcp') {
      var t = state.sources.modbusTcp;
      return { transport: 'tcp', tcp_framing: t.tcp_framing || 'tcp', profile: t.profile, host: t.host, port: t.port, unit: t.unit };
    }
    var s = state.sources.modbusSerial;
    return { transport: 'serial', profile: s.profile, serial_path: s.serial_path, serial_baud: s.serial_baud, serial_data_bits: s.serial_data_bits, serial_parity: s.serial_parity, serial_stop_bits: s.serial_stop_bits, unit: s.unit };
  }

  function apiErrMsg(res, label) {
    if (res.data && typeof res.data === 'object') {
      if (res.data.error) return String(res.data.error);
      if (res.data.message) return String(res.data.message);
    }
    return label + ' test failed (' + (res.status || 'network') + ').';
  }

  function dongleTestBody() {
    var d = state.sources.dongle;
    if (d.link === 'bluetooth') {
      return { transport: dongleTransport(), profile: d.profile, ble_address: d.ble_address, ble_write_uuid: d.ble_write_uuid, ble_notify_uuid: d.ble_notify_uuid, modbus_unit_id: d.modbus_unit_id, dongle_serial: d.dongle_serial, inverter_serial: d.inverter_serial };
    }
    var body = { host: d.host, port: d.port, modbus_unit_id: d.modbus_unit_id, transport: dongleTransport(), dongle_serial: d.dongle_serial, inverter_serial: d.inverter_serial };
    if (d.serial_number) body.serial_number = d.serial_number;
    return body;
  }

  function renderHAEntities(entities) {
    var box = $('#ha-entities');
    if (!box) return;
    if (!entities.length) { box.innerHTML = ''; return; }
    var items = entities.slice(0, 60).map(function (e) {
      return '<div class="wz-list-item"><code>' + esc(e) + '</code></div>';
    }).join('');
    box.innerHTML = '<div class="wz-list-head"><span class="wz-label">' + entities.length + ' entities found</span>'
      + (entities.length > 60 ? '<span class="wz-hint">Showing the first 60</span>' : '') + '</div>'
      + '<div class="wz-list">' + items + '</div>'
      + '<p class="wz-hint" style="margin-top:8px">You\'ll pick which ones to use in the next step.</p>';
  }

  function runBrowseTopics() {
    var s = state.sources.mqtt;
    var box = $('#mqtt-topics');
    var btn = $('[data-action="browse-topics"]');
    if (btn) btn.classList.add('is-busy');
    if (box) box.innerHTML = '<p class="wz-hint">Listening for topics…</p>';
    api('/api/mqtt-discover-topics', { method: 'POST', body: JSON.stringify({ broker: s.broker, username: s.username, password: s.password }) }).then(function (res) {
      if (btn) btn.classList.remove('is-busy');
      if (!box) return;
      if (res.ok && res.data && res.data.success && Array.isArray(res.data.topics)) {
        var topics = res.data.topics;
        s.discoveredTopics = topics;
        var items = topics.map(function (t) {
          var on = !!s.selectedTopics[t];
          return '<button type="button" class="wz-list-item' + (on ? ' is-on' : '') + '" data-action="toggle-topic" data-topic="' + esc(t) + '" aria-pressed="' + on + '">'
            + '<span class="wz-tick">' + icon('check', 12) + '</span><code>' + esc(t) + '</code></button>';
        }).join('');
        box.innerHTML = '<div class="wz-list-head"><span class="wz-label">' + (res.data.count || topics.length) + ' topics found</span><span class="wz-hint">Select the ones to read</span></div>'
          + (topics.length ? '<div class="wz-list">' + items + '</div>' : alertBox('info', 'No topics were published while listening. Check that your devices are sending, then try again.'));
      } else {
        box.innerHTML = alertBox('error', 'Couldn\'t browse topics: ' + esc(apiErrMsg(res, 'MQTT')));
      }
    }).catch(function () {
      if (btn) btn.classList.remove('is-busy');
      if (box) box.innerHTML = alertBox('error', 'Network error while browsing topics.');
    });
  }

  function toggleTopic(btn) {
    var t = btn.getAttribute('data-topic');
    var s = state.sources.mqtt;
    if (s.selectedTopics[t]) delete s.selectedTopics[t];
    else s.selectedTopics[t] = true;
    var on = !!s.selectedTopics[t];
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  // ── Build devices + save sources ──────────────────────────
  // Preserve a Settings-owned metric/mapping map across a wizard re-save.
  // existing = state.existing (wizard's loaded config) or undefined.
  // configKey = 'ha_devices'|'dongle_config'|'rs232_devices'; mapKey = 'entities'|'mappings'.
  // deviceName: optional match by device name; if falsy, use the first slot for single-slot sources.
  function carryForwardMap(existing, configKey, mapKey, deviceName) {
    var out = {};
    try {
      var raw = existing ? existing[configKey] : null;
      if (!raw) return out;
      var arr = Array.isArray(raw) ? raw : JSON.parse(raw);
      if (!Array.isArray(arr)) return out;
      var hit = null;
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i] || {};
        if (deviceName) { if (d.name === deviceName) { hit = d; break; } }
        else { hit = d; break; }
      }
      if (hit && hit[mapKey] && typeof hit[mapKey] === 'object') out = hit[mapKey];
    } catch (e) { out = {}; }
    try { return JSON.parse(JSON.stringify(out)); } catch (e) { return {}; }
  }
  function buildHADevices() {
    if (!state.sources.ha.selected) return [];
    var s = state.sources.ha;
    var entities = carryForwardMap(state.existing, 'ha_devices', 'entities', '');
    Object.keys(s.roleEntities || {}).forEach(function (id) { if (entities[id] === undefined) entities[id] = id; });
    return [{ name: s.name || 'Home Assistant', url: s.url, token: s.token, enabled: true, poll_interval: parseInt(s.poll_interval, 10) || 30, entities: entities }];
  }
  function buildMQTTDevices() {
    if (!state.sources.mqtt.selected) return [];
    var s = state.sources.mqtt;
    var topics = Object.assign({}, s.topics || {});
    var mapped = {}; Object.keys(topics).forEach(function (k) { mapped[topics[k]] = true; });
    Object.keys(s.selectedTopics || {}).forEach(function (t) { if (!mapped[t] && topics[t] === undefined) topics[t] = t; });
    return [{ name: s.name || 'MQTT Broker', broker: s.broker, username: s.username || '', password: s.password || '', enabled: true, poll_interval: parseInt(s.poll_interval, 10) || 30, topics: topics }];
  }
  function buildDongleConfig() {
    if (!state.sources.dongle.selected) return (state.keep && state.keep.dongle_config) || [];
    var d = state.sources.dongle;
    var dev = { name: d.name || 'Inverter (dongle)', enabled: true, profile: d.profile, transport: dongleTransport(), host: d.host, port: d.port, serial_number: d.serial_number, modbus_unit_id: d.modbus_unit_id, poll_interval: parseInt(d.poll_interval, 10) || 30, prefix: d.prefix, mappings: effectiveMappings('dongle') };
    if (isLuxDongleProfile(currentDongleProfile())) {
      dev.dongle_serial = String(d.dongle_serial || '').trim();
      dev.inverter_serial = String(d.inverter_serial || '').trim();
      dev._luxpowerPhase2 = true;
    }
    if (d.link === 'bluetooth') {
      dev.ble_address = String(d.ble_address || '').trim().toUpperCase();
      dev.ble_write_uuid = d.ble_write_uuid || '';
      dev.ble_notify_uuid = d.ble_notify_uuid || '';
      dev.host = ''; dev.port = undefined; dev.serial_number = '';
    }
    var out = withExtras('dongle', dev);
    return out.concat(state.keep.dongle_config || []);
  }
  /**
   * The first unit plus "more inverters like this one": each extra copies the
   * first's settings, with its own name, prefix, connection and mappings
   * renamed under its prefix (inv1_pv_power -> inv2_pv_power).
   */
  function withExtras(kind, dev) {
    var s = state.sources[kind], bt = kind === 'dongle' && s.link === 'bluetooth';
    var out = [dev];
    (s.more || []).forEach(function (m, i) {
      var extra = Object.assign({}, m._saved || {}, dev, {
        name: (m.name || '').trim() || ('Inverter ' + (i + 2)), prefix: extraPrefix(m, i),
        mappings: withPrefix(dev.mappings, firstPrefix(kind), extraPrefix(m, i))
      });
      if (bt) extra.ble_address = String(m.ble_address || '').trim().toUpperCase();
      else if (kind === 'dongle') { extra.host = m.host || ''; extra.port = m.port || dev.port; extra.serial_number = m.serial_number || ''; }
      else if (kind === 'modbusTcp') { extra.host = (m.host || '').trim() || dev.host; extra.port = parseInt(m.port, 10) || dev.port; extra.unit = parseInt(m.unit, 10) || dev.unit; }
      else if (kind === 'modbusSerial') { extra.serial_path = (m.serial_path || '').trim() || dev.serial_path; extra.unit = parseInt(m.unit, 10) || dev.unit; }
      else if (kind === 'rs232') extra.serial_path = (m.serial_path || '').trim();
      out.push(extra);
    });
    return out;
  }
  /** The same mappings under another prefix: inv1_pv_power -> inv2_pv_power. */
  function withPrefix(mappings, from, to) {
    var out = {};
    Object.keys(mappings || {}).forEach(function (name) {
      var base = from && name.indexOf(from) === 0 ? name.slice(from.length) : name;
      out[to + base] = mappings[name];
    });
    return out;
  }
  function buildRS232Device(opts) {
    var r = state.sources.rs232;
    var dev = { name: r.name || 'Inverter (RS232)', serial_path: resolveSerialPath(r), baud: r.baud, modbus_unit_id: r.modbus_unit_id, parity: r.parity, data_bits: r.data_bits, stop_bits: r.stop_bits, profile: r.profile, timeout: r.timeout ? parseInt(r.timeout, 10) : 5, enabled: r.enabled, mappings: effectiveMappings('rs232') };
    return dev;
  }
  function buildRS232Devices() {
    if (!state.sources.rs232.selected) return [];
    return withExtras('rs232', buildRS232Device());
  }
  function buildModbusDevices() {
    var out = [];
    var ms = state.sources.modbusSerial;
    if (ms.selected) {
      out = out.concat(withExtras('modbusSerial', { name: ms.name || 'Inverter (RS485)', enabled: true, transport: 'serial', profile: ms.profile || '', serial_path: ms.serial_path || '', serial_baud: parseInt(ms.serial_baud, 10) || 9600, serial_data_bits: parseInt(ms.serial_data_bits, 10) || 8, serial_parity: ms.serial_parity || 'none', serial_stop_bits: parseInt(ms.serial_stop_bits, 10) || 1, unit: parseInt(ms.unit, 10) || 1, poll_interval: parseInt(ms.poll_interval, 10) || 30, mappings: effectiveMappings('modbusSerial') }));
    }
    var mt = state.sources.modbusTcp;
    if (mt.selected) {
      out = out.concat(withExtras('modbusTcp', { name: mt.name || 'Inverter (Modbus-TCP)', enabled: true, transport: 'tcp', tcp_framing: mt.tcp_framing || 'tcp', profile: mt.profile || '', host: mt.host || '', port: parseInt(mt.port, 10) || 502, unit: parseInt(mt.unit, 10) || 1, poll_interval: parseInt(mt.poll_interval, 10) || 30, mappings: effectiveMappings('modbusTcp') }));
    }
    return out;
  }
  function buildBmsDevices() {
    var out = [];
    if (state.sources.bms.selected) {
      var b = state.sources.bms;
      out.push({ name: b.name || 'BMS (Bluetooth)', enabled: true, transport: 'bluetooth', address: b.address || '', poll_interval: parseInt(b.poll_interval, 10) || 30, mappings: b.mappings || {} });
    }
    if (state.sources.bmsWired.selected) {
      var w = state.sources.bmsWired;
      out.push({ name: w.name || 'BMS (RS485/RS232)', enabled: true, transport: 'wired', serial_path: w.serial_path || '', baud: parseInt(w.baud, 10) || 9600, data_bits: parseInt(w.data_bits, 10) || 8, parity: w.parity || 'none', stop_bits: parseInt(w.stop_bits, 10) || 1, modbus_unit_id: parseInt(w.modbus_unit_id, 10) || 1, profile: w.profile || '', timeout: parseInt(w.timeout, 10) || 5000, poll_interval: parseInt(w.poll_interval, 10) || 30, mappings: w.mappings || {} });
    }
    return out;
  }
  function buildRestDevices() {
    if (!state.sources.rest.selected) return [];
    var r = state.sources.rest;
    return [{ name: r.name || 'REST API', enabled: true, url: r.url || '', mappings: r.mappings || {} }];
  }
  // Wizard-owned cache of discovery results so the metrics step (step 3) can
  // offer candidates on re-entry without re-probing sources. Never used by
  // Settings' metric→entity map; that stays in ha_devices[0].entities.
  function buildProbeCache() {
    return JSON.stringify({
      ha: state.sources.ha.entities || [],
      mqtt: state.sources.mqtt.selectedTopics || {},
      dongle: state.sources.dongle.mappings || {},
      rs232: state.sources.rs232.mappings || {},
      modbus: state.sources.modbusSerial.mappings || state.sources.modbusTcp.mappings || {}
    });
  }

  function saveSources() {
    if (!validateSources()) return Promise.resolve(false);
    var body = {
      ha_devices: JSON.stringify(withKept('ha_devices', buildHADevices())),
      mqtt_devices: JSON.stringify(withKept('mqtt_devices', buildMQTTDevices())),
      dongle_config: JSON.stringify(buildDongleConfig()),
      rs232_devices: JSON.stringify(withKept('rs232_devices', buildRS232Devices())),
      modbus_devices: JSON.stringify(withKept('modbus_devices', buildModbusDevices())),
      external_sources: JSON.stringify(withKept('external_sources', buildRestDevices())),
      bms_devices: JSON.stringify(withKept('bms_devices', buildBmsDevices())),
      setup_probe_cache: buildProbeCache()
    };
    return api('/api/settings/data-sources', { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
      if (res.ok && res.data && (res.data.ok || res.data.success)) {
        hideSourcesError();
        clearSourceErrors();
        return true;
      }
      showSourcesError('Could not save data sources (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'));
      return false;
    }).catch(function () {
      showSourcesError('Network error saving data sources.');
      return false;
    });
  }
  function moreInverterProblem(kind) {
    var s = state.sources[kind], bt = kind === 'dongle' && s.link === 'bluetooth', prefixes = {}, conns = {};
    if (!(s.more || []).length) return '';
    if (!Object.keys(effectiveMappings(kind)).length) return 'Choose the inverter profile first, so the other inverters know which readings to take.';
    var conn = function (x, isFirst) {
      if (bt) return String(x.ble_address || '').trim().toUpperCase();
      if (kind === 'modbusTcp') return [(x.host || s.host || '').trim(), x.port || s.port, x.unit || s.unit].join('|');
      if (kind === 'modbusSerial') return [(x.serial_path || s.serial_path || '').trim(), x.unit || (isFirst ? s.unit : '')].join('|');
      if (kind === 'rs232') return isFirst ? resolveSerialPath(s) : String(x.serial_path || '').trim();
      return [(x.host || '').trim(), x.port || s.port].join('|');
    };
    prefixes[firstPrefix(kind).trim().toLowerCase()] = s.name || 'the first inverter';
    conns[conn(s, true)] = s.name || 'the first inverter';
    for (var i = 0; i < s.more.length; i++) {
      var m = s.more[i], name = (m.name || '').trim() || ('Inverter ' + (i + 2));
      if (bt && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(String(m.ble_address || '').trim())) return 'Add the Bluetooth address for ' + name + '.';
      if (kind === 'dongle' && !bt && !(m.host && (m.port || s.port))) return 'Add the IP address for ' + name + '.';
      if (kind === 'modbusSerial' && !(parseInt(m.unit, 10) >= 1)) return 'Add the unit ID for ' + name + '.';
      if (kind === 'rs232' && !String(m.serial_path || '').trim()) return 'Add the serial port for ' + name + '.';
      var p = String(m.prefix || '').trim().toLowerCase();
      if (!p) return 'Give ' + name + ' a metric name prefix, for example inv' + (i + 2) + '_.';
      if (prefixes[p]) return name + ' and ' + prefixes[p] + ' have the same prefix, so their readings would overwrite each other.';
      prefixes[p] = name;
      var c = conn(m, false);
      if (conns[c]) return name + ' and ' + conns[c] + ' are set to the same ' + (kind === 'modbusTcp' || kind === 'modbusSerial' ? 'connection and unit ID' : bt ? 'Bluetooth address' : kind === 'rs232' ? 'serial port' : 'address') + ', so it would read the same inverter twice.';
      conns[c] = name;
    }
    return '';
  }
  function withKept(key, list) { return (list || []).concat((state.keep && state.keep[key]) || []); }
  function showSourcesError(msg) { var el = $('#sources-error'); if (el) { el.textContent = msg; el.hidden = false; } }
  function hideSourcesError() { var el = $('#sources-error'); if (el) el.hidden = true; }

  // Required-field validation for selected sources (mirrors hasMinimal gating used for Test).
  // Returns { sourceKey: errorMessage } for each selected source missing required fields.
  function sourceValidationErrors() {
    var errors = {};
    SOURCE_KEYS.forEach(function (k) {
      if (!state.sources[k].selected) return;
      var s = state.sources[k];
      if (k === 'ha' && !(s.url && s.token)) errors.ha = 'Add the Home Assistant address and access token.';
      else if (k === 'mqtt' && !s.broker) errors.mqtt = 'Add the broker address.';
      else if (k === 'dongle' && s.link === 'bluetooth' && !(s.ble_address && s.profile)) errors.dongle = 'Choose the Bluetooth module and an inverter profile.';
      else if (k === 'dongle' && isLuxDongleProfile(currentDongleProfile()) && !(/^[A-Za-z0-9]{10}$/.test(String(s.dongle_serial || '').trim()) && /^[A-Za-z0-9]{10}$/.test(String(s.inverter_serial || '').trim()))) errors.dongle = 'LuxPower needs the 10-character dongle serial and inverter serial from the labels.';
      else if (k === 'dongle' && s.link !== 'bluetooth' && !(s.host && s.port && s.profile)) errors.dongle = 'Add the IP address and port, and choose an inverter profile.';
      else if (k === 'rs232' && !(resolveSerialPath(s) && s.profile)) errors.rs232 = 'Choose the serial port and an inverter profile.';
      else if (k === 'modbusSerial' && !s.serial_path) errors.modbusSerial = 'Add the serial port path.';
      else if (k === 'modbusTcp' && !(s.host && s.port)) errors.modbusTcp = 'Add the IP address and port.';
      else if (k === 'bms' && !s.address) errors.bms = 'Scan for your battery, or type its Bluetooth address.';
      else if (k === 'bmsWired' && !(s.serial_path && s.profile && s.modbus_unit_id)) errors.bmsWired = 'Choose the serial port and a BMS profile, and add the unit ID.';
      else if (MORE_KINDS.indexOf(k) >= 0 && moreInverterProblem(k)) errors[k] = moreInverterProblem(k);
      else if (k === 'rest' && !s.url) errors.rest = 'Add the endpoint URL.';
    });
    return errors;
  }
  // Blocks Save/Next when a selected source has empty required fields. Shows inline per-source hints.
  function validateSources() {
    if (selectedSourcesCount() === 0) {
      showSourcesError('Pick at least one source.');
      return false;
    }
    var errors = sourceValidationErrors();
    var keys = Object.keys(errors);
    if (keys.length) {
      keys.forEach(function (k) { setError(k, errors[k]); });
      showSourcesError('Some sources are missing details. They\'re marked above.');
      return false;
    }
    hideSourcesError();
    clearSourceErrors();
    return true;
  }
  function clearSourceErrors() {
    SOURCE_KEYS.forEach(function (k) { clearError(k); });
  }

  // ── "Start fresh" — clear data sources (behind confirm) ───────
  function showResetNote() {
    var el = $('#reset-sources-note');
    if (el) { el.textContent = 'All sources cleared.'; el.hidden = false; }
  }

  function resetSources() {
    confirmDialog('Clear all sources?', 'This removes every data source and metric role, and marks setup as not done. History, metrics and snapshots stay.', 'Clear sources').then(function (ok) {
      if (!ok) return;
      setBusy(true);
      api('/api/wizard/reset', { method: 'POST', body: '{}' }).then(function (res) {
        if (res.ok && res.data && res.data.success) {
          resetClientState();
          loadExistingConfig().then(function () { setBusy(false); gotoStep(state.currentStep); showResetNote(); })
            .catch(function () { setBusy(false); gotoStep(state.currentStep); showResetNote(); });
        } else {
          setBusy(false);
          showSourcesError('Couldn\'t clear the sources (error ' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'));
        }
      }).catch(function () {
        setBusy(false);
        showSourcesError('Network error while clearing the sources.');
      });
    });
  }
  // Resolves true when the person confirms.
  function confirmDialog(title, text, okLabel) {
    var d = $('#wz-dialog');
    if (!d || typeof d.showModal !== 'function') return Promise.resolve(window.confirm(title + '\n\n' + text));
    $('#wz-dialog-title').textContent = title;
    $('#wz-dialog-body').textContent = text;
    $('#wz-dialog-ok').textContent = okLabel;
    d.returnValue = '';
    d.showModal();
    return new Promise(function (resolve) {
      d.addEventListener('close', function onClose() { d.removeEventListener('close', onClose); resolve(d.returnValue === 'ok'); });
    });
  }

  function resetClientState() {
    // Revert the wizard's local source state so a cleared server state is fully reflected.
    state.sources = defaultSources();
    state.keep = {};
    state.roleMetrics = {};
    state.dashboard.choice = 'full';
    state.optional = {
      pvoutput: { enabled: false, api_key: '', system_id: '', timezone: '', upload_interval_minutes: '5', system_size_w: '0', net_mode: false, webhook_url: '', metric_map: {} },
      forecast: { enabled: false, latitude: '', longitude: '', tilt: '30', azimuth: '180', solcast_api_key: '', solcast_resource_id: '', loss_factor: '0.9', install_date: '' },
      network: { local_url: '', remote_url: '' }
    };
  }

  // ── STEP 3: METRICS ───────────────────────────────────────
  // Bluetooth BMS keys before a test has read the real ones (aiobmsble names).
  var BLE_BMS_KEYS = ['battery_level', 'voltage', 'current', 'power', 'temperature', 'cycle_charge', 'cycles', 'battery_charging'];

  // Metric names the configured sources will actually write, grouped so
  // inverter/BMS names can drive the auto-fill before HA/MQTT ones.
  function sourceMetricNames() {
    var inverter = [], bms = [], other = [];
    ['dongle', 'rs232', 'modbusSerial', 'modbusTcp'].forEach(function (k) {
      if (state.sources[k].selected) Object.keys(effectiveMappings(k)).forEach(function (n) { inverter.push(n); });
    });
    MORE_KINDS.forEach(function (k) {
      var src = state.sources[k];
      if (src.selected) (src.more || []).forEach(function (m, i) { Object.keys(withPrefix(effectiveMappings(k), firstPrefix(k), extraPrefix(m, i))).forEach(function (n) { inverter.push(n); }); });
    });
    var b = state.sources.bms;
    if (b.selected) (b.sampleKeys && b.sampleKeys.length ? b.sampleKeys : BLE_BMS_KEYS).forEach(function (k) { bms.push(bmsMetricName(b.name || 'BMS (Bluetooth)', k)); });
    var w = state.sources.bmsWired;
    if (w.selected) ((w.sampleKeys && w.sampleKeys.length) ? w.sampleKeys : (w.fieldKeys || [])).forEach(function (k) { bms.push(bmsMetricName(w.name || 'BMS (RS485/RS232)', k)); });
    if (state.sources.ha.selected) state.sources.ha.entities.forEach(function (e) { other.push(e); });
    if (state.sources.mqtt.selected) Object.keys(state.sources.mqtt.selectedTopics).forEach(function (t) { other.push(t); });
    return { inverter: inverter, bms: bms, other: other };
  }
  function knownMetricNames(suggestions) {
    var known = {};
    (suggestions || []).forEach(function (n) { known[n] = true; });
    var ex = state.existing || {};
    function arr(v) { if (Array.isArray(v)) return v; try { var a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
    arr(ex.tuya_devices).forEach(function (d) { Object.values((d && d.dps) || {}).forEach(function (v) { if (typeof v === 'string') known[v] = true; else if (v && v.metric) known[v.metric] = true; }); });
    arr(ex.external_sources).forEach(function (d) { Object.keys((d && d.mappings) || {}).forEach(function (k) { known[k] = true; }); });
    arr(ex.bms_devices).forEach(function (d) { Object.values((d && d.mappings) || {}).forEach(function (v) { if (v) known[v] = true; }); });
    arr(ex.bms_banks).forEach(function (bank) { ((bank && bank.functions) || []).forEach(function (f) { if (f && f.output) known[f.output] = true; }); });
    return known;
  }
  function roleSuggestions() {
    var g = sourceMetricNames();
    var set = {};
    g.inverter.concat(g.bms, g.other).forEach(function (n) { set[n] = true; });
    return Object.keys(set);
  }
  function metricsNames(list) {
    list = list || [];
    var names = [];
    function push(n) { if (n && n.trim() && names.indexOf(n) === -1) names.push(n); }
    list.forEach(function (m) {
      if (typeof m === 'string') push(m);
      else if (m) push(m.name || m.key || m.metric || '');
    });
    return names;
  }
  function profileHint(list) {
    var names = metricsNames(list);
    var lower = names.map(function (n) { return n.toLowerCase(); });
    var hint = {};
    // exclude: a regex of names that can never fill the role (e.g. a power role
    // must not pick grid_voltage just because it contains "grid").
    function find(keys, exclude) {
      for (var i = 0; i < keys.length; i++) {
        for (var j = 0; j < lower.length; j++) {
          if (exclude && exclude.test(lower[j])) continue;
          if (lower[j].indexOf(keys[i]) > -1) return names[j];
        }
      }
      return null;
    }
    var NOT_POWER = /(voltage|volt\b|current|frequency|freq|temp|percent|_pct|soc|level|_va\b|apparent|energy|kwh|daily|total_)/;
    var s = find(['solar_power', 'pv_power', 'pv_total_power', 'pv1_power', 'avatar_power', 'pv', 'solar'], NOT_POWER); if (s) hint.solar = s;
    var g = find(['grid_power', 'grid_import', 'buy', 'grid'], NOT_POWER); if (g) hint.grid_import = g;
    var l = find(['load_power', 'consumption', 'home_power', 'output_power', 'ac_output_power', 'load'], NOT_POWER); if (l) hint.consumption = l;
    // A signed battery power fills both roles; separate charge/discharge
    // metrics (e.g. Phocos battery_discharge_power) only fill their own.
    var b = find(['battery_power'], NOT_POWER);
    var ch = find(['battery_charge_power', 'charge_power', 'battery_charging_power'], /discharg/) || b;
    var dch = find(['battery_discharge_power', 'discharge_power'], NOT_POWER) || b;
    if (!b && !ch && !dch) { b = find(['battery'], /(discharg|voltage|volt\b|current|frequency|freq|temp|percent|_pct|soc|level|energy|kwh)/); ch = ch || b; dch = dch || b; }
    if (ch) hint.battery_charge = ch;
    if (dch) hint.battery_discharge = dch;
    var soc = find(['battery_soc', 'soc', 'battery_level']); if (soc) hint.battery_soc = soc;
    var v = find(['solar_voltage', 'panel_voltage', 'pv_voltage', 'pv1_voltage', 'pv_input_voltage']); if (v) hint.solar_voltage = v;
    // daily-ish role hints
    function findDaily(words) { for (var w = 0; w < words.length; w++) for (var j = 0; j < names.length; j++) if (names[j].indexOf(words[w]) > -1) return names[j]; return null; }
    var ds = findDaily(['daily_solar', 'day_solar', 'kwh*', 'pv_daily']); if (ds) hint.daily_solar = ds;
    return hint;
  }

  function renderStep3() {
    var body = $('#step-3-body');
    var suggestions = roleSuggestions();
    var groups = sourceMetricNames();
    // Inverter names fill the power roles first; BMS names only fill what is left (SOC etc.).
    var hint = profileHint(groups.inverter);
    var hint2 = profileHint(groups.bms);
    if (!hint.battery_soc && hint2.battery_soc) hint.battery_soc = hint2.battery_soc;

    var html = suggestions.length
      ? alertBox('info', 'Your sources offer <strong>' + suggestions.length + '</strong> readings. Click a box to pick from them, or type a name. Guesses are filled in where Epilykos could tell.')
      : alertBox('warn', 'No readings to choose from yet. Go back and pick a profile, or test your battery or Home Assistant connection. You can also type the name you expect, or skip this and match them in Settings later.');

    // Names something already writes: the sources above plus metric names
    // mapped in Settings (Tuya, REST, BMS mappings…).
    var known = knownMetricNames(suggestions);
    var byKey = {}; ROLES.forEach(function (r) { byKey[r.key] = r; });
    ROLE_GROUPS.forEach(function (g) {
      html += '<h2 class="wz-section-title">' + esc(g.label) + '</h2>'
        + (g.hint ? '<p class="wz-hint" style="margin:-6px 0 10px">' + esc(g.hint) + '</p>' : '')
        + '<div class="wz-card"><div class="wz-roles">';
      g.keys.forEach(function (key) {
        var r = byKey[key];
        var cur = (state.roleMetrics[r.key] || '').trim();
        // Fresh installs start with the default dashboard's placeholder names
        // (history.js auto-fill); a real metric from a source replaces them.
        var val = (cur && (known[cur] || !hint[r.key])) ? cur : (hint[r.key] || '');
        if (val !== cur) state.roleMetrics[r.key] = val;
        var warn = (val && suggestions.length && !known[val]) ? 'None of your sources has a reading called “' + esc(val) + '” yet.' : '';
        var id = 'role-' + r.key;
        html += '<div class="wz-role">'
          + '<label class="wz-role-label" for="' + id + '">' + esc(r.label) + ' <span class="wz-unit">' + esc(r.unit) + '</span></label>'
          + '<input class="wz-input" id="' + id + '" list="role-suggestions" data-metric-role="' + esc(r.key) + '" value="' + esc(val) + '" placeholder="Not used" autocomplete="off" spellcheck="false">'
          + '<p class="wz-role-warn" data-role-warn="' + esc(r.key) + '"' + (warn ? '' : ' hidden') + '>' + warn + '</p>'
          + '</div>';
      });
      html += '</div></div>';
    });
    // Power with no energy reading (e.g. Phocos over Bluetooth): offer to work
    // out today's kWh from power (renderEnergyOffers keeps it in step with the roles).
    html += '<div id="combine-offers"></div><div id="energy-offers"></div>';
    html += '<datalist id="role-suggestions">' + suggestions.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>'
      + '<div class="wz-alert is-error" id="metrics-error" role="alert" hidden></div>';
    body.innerHTML = html;
    renderCombineOffers();
    renderEnergyOffers();
    body._known = known;
    body._hasSuggestions = suggestions.length > 0;
  }

  // Daily roles that can be worked out from a power role.
  var ENERGY_FROM_POWER = [
    { power: 'solar', daily: 'daily_solar', name: 'solar_energy_today', label: 'Solar energy today' },
    { power: 'consumption', daily: 'daily_consumption', name: 'load_energy_today', label: 'Home energy today' },
    { power: 'battery_charge', daily: 'daily_battery_charge', name: 'battery_charge_energy_today', label: 'Battery charge energy today' },
    { power: 'battery_discharge', daily: 'daily_battery_discharge', name: 'battery_discharge_energy_today', label: 'Battery discharge energy today' },
    { power: 'grid_import', daily: 'daily_grid_import', name: 'grid_import_energy_today', label: 'Grid import energy today' },
    { power: 'grid_export', daily: 'daily_grid_export', name: 'grid_export_energy_today', label: 'Grid export energy today' }
  ];
  // Several inverters of one kind: add the same reading up across all of them.
  var COMBINE_ROLES = [
    ['solar', 'Solar power', 'sum', 'W'], ['consumption', 'Home use', 'sum', 'W'], ['battery_charge', 'Battery charge power', 'sum', 'W'],
    ['battery_discharge', 'Battery discharge power', 'sum', 'W'], ['grid_import', 'Grid import', 'sum', 'W'], ['grid_export', 'Grid export', 'sum', 'W'],
    ['battery_soc', 'Battery charge (%)', 'mean', '%'], ['daily_solar', 'Daily solar', 'sum', 'kWh'], ['daily_consumption', 'Daily home use', 'sum', 'kWh']
  ];
  function combineOffers() {
    var taken = {};
    return MORE_KINDS.reduce(function (all, kind) {
      var src = state.sources[kind], prefix = firstPrefix(kind);
      if (!src.selected || !(src.more || []).length) return all;
      var names = effectiveMappings(kind);
      COMBINE_ROLES.forEach(function (r) {
        var v = (state.roleMetrics[r[0]] || '').trim();
        if (!v || taken[r[0]] || !Object.prototype.hasOwnProperty.call(names, v) || v.indexOf(prefix) !== 0) return;
        var base = v.slice(prefix.length);
        taken[r[0]] = true;
        all.push({ role: r[0], label: r[1], fn: r[2], unit: r[3], inputs: [v].concat(src.more.map(function (m, i) { return extraPrefix(m, i) + base; })), name: (r[2] === 'mean' ? 'average_' : 'total_') + base });
      });
      return all;
    }, []);
  }
  function renderCombineOffers() {
    var box = $('#combine-offers'); if (!box) return;
    var offers = combineOffers();
    state.combineOffers = state.combineOffers || {};
    if (!offers.length) { box.innerHTML = ''; return; }
    var n = offers[0].inputs.length;
    var html = '<h2 class="wz-section-title">Combine your ' + n + ' inverters</h2><p class="wz-hint" style="margin:-6px 0 10px">Each inverter reports its own readings. Tick the ones to add up into a total for the whole system; the role then uses the total. Change this later in Settings \u203a Metrics \u203a Combined metrics.</p><div class="wz-card"><div class="wz-card-body">';
    offers.forEach(function (o) {
      html += '<label class="wz-check"><input type="checkbox" data-combine-offer="' + o.role + '"' + (state.combineOffers[o.role] !== false ? ' checked' : '') + '> ' + esc(o.label) + ': ' + (o.fn === 'mean' ? 'average of ' : 'add up ') + n + ' inverters <span class="wz-hint">as ' + esc(o.name) + '</span></label>';
    });
    box.innerHTML = html + '</div></div>';
  }
  /** Add the ticked inverter totals as Combined metrics and point the roles at them. */
  function saveCombineOffers(map) {
    var picks = combineOffers().filter(function (o) { return map[o.role] && state.combineOffers && state.combineOffers[o.role] !== false; });
    if (!picks.length) return Promise.resolve(true);
    return api('/api/combined-metrics').then(function (res) {
      var defs = (res.data && res.data.definitions) || [];
      picks.forEach(function (o) {
        var existing = defs.find(function (d) { return d.name === o.name; });
        if (existing) { existing.inputs = o.inputs; existing.fn = o.fn; existing.enabled = true; }
        else defs.push({ name: o.name, unit: o.unit, fn: o.fn, inputs: o.inputs, enabled: true, note: 'Added by the setup wizard' });
        map[o.role] = o.name;
      });
      return api('/api/combined-metrics', { method: 'POST', body: JSON.stringify({ definitions: defs }) });
    }).then(function (res) {
      if (res === true || res.ok) return true;
      var el = $('#metrics-error'); if (el) { el.textContent = 'Could not set up the inverter totals: ' + apiErrMsg(res, 'Server'); el.hidden = false; }
      return false;
    });
  }
  function renderEnergyOffers() {
    var box = $('#energy-offers'); if (!box) return;
    var offers = ENERGY_FROM_POWER.filter(function (o) { return (state.roleMetrics[o.power] || '').trim() && !(state.roleMetrics[o.daily] || '').trim(); });
    state.energyOffers = state.energyOffers || {};
    if (!offers.length) { box.innerHTML = ''; return; }
    var html = '<h2 class="wz-section-title">Energy from power</h2><p class="wz-hint" style="margin:-6px 0 10px">These readings have power but no daily energy. Epilykos can work out today\'s kWh from power and use it for daily totals and savings. Change this later in Settings \u203a Metrics \u203a Combined metrics.</p><div class="wz-card"><div class="wz-card-body">';
    offers.forEach(function (o) {
      var total = combineOffers().filter(function (c) { return c.role === o.power && state.combineOffers && state.combineOffers[c.role] !== false; })[0];
      html += '<label class="wz-check"><input type="checkbox" data-energy-offer="' + o.power + '"' + (state.energyOffers[o.power] !== false ? ' checked' : '') + '> ' + esc(o.label) + ' <span class="wz-hint">from ' + esc(total ? total.name : state.roleMetrics[o.power]) + '</span></label>';
    });
    box.innerHTML = html + '</div></div>';
  }
  /** Add the ticked energy-from-power Combined metrics and point the daily roles at them. */
  function saveEnergyOffers(map) {
    var picks = ENERGY_FROM_POWER.filter(function (o) { return map[o.power] && !map[o.daily] && state.energyOffers && state.energyOffers[o.power] !== false && document.querySelector('[data-energy-offer="' + o.power + '"]'); });
    if (!picks.length) return Promise.resolve(true);
    return api('/api/combined-metrics').then(function (res) {
      var defs = (res.data && res.data.definitions) || [];
      picks.forEach(function (o) {
        var existing = defs.find(function (d) { return d.name === o.name; });
        if (!existing) defs.push({ name: o.name, unit: 'kWh', fn: 'energy_today', inputs: [map[o.power]], input_unit: 'W', enabled: true, note: 'Added by the setup wizard' });
        else { existing.inputs = [map[o.power]]; existing.enabled = true; }
        map[o.daily] = o.name;
      });
      return api('/api/combined-metrics', { method: 'POST', body: JSON.stringify({ definitions: defs }) });
    }).then(function (res) {
      if (res.ok) return true;
      var el = $('#metrics-error'); if (el) { el.textContent = 'Could not set up energy from power: ' + apiErrMsg(res, 'Server'); el.hidden = false; }
      return false;
    });
  }

  function saveRoleMetrics() {
    // Keep existing roles by sending the full mapping of non-empty values.
    var map = {};
    ROLES.forEach(function (r) { var v = (state.roleMetrics[r.key] || '').trim(); if (v) map[r.key] = v; });
    // A Home Assistant entity picked for a role must be polled, so add it to
    // the HA device's entity map (metric name = entity id) and re-save sources.
    var ha = state.sources.ha;
    var haIds = {}; (ha.entities || []).forEach(function (e) { haIds[e] = true; });
    ha.roleEntities = {};
    Object.keys(map).forEach(function (k) { if (haIds[map[k]]) ha.roleEntities[map[k]] = true; });
    var pre = (ha.selected && Object.keys(ha.roleEntities).length) ? saveSources() : Promise.resolve(true);
    return pre.then(function (okSources) {
      if (!okSources) {
        var e1 = $('#metrics-error'); if (e1) { e1.textContent = 'Could not save the Home Assistant entities for these roles.'; e1.hidden = false; }
        return { sourcesFailed: true };
      }
      return saveCombineOffers(map).then(function (ok) { return ok ? saveEnergyOffers(map) : false; }).then(function (ok) {
        if (!ok) return { sourcesFailed: true };
        return api('/api/role-metrics', { method: 'POST', body: JSON.stringify(map) });
      });
    }).then(function (res) {
      if (res.sourcesFailed) return false;
      if (res.ok && res.data && res.data.success) return true;
      var el = $('#metrics-error'); if (el) { el.textContent = 'Could not save metric mapping (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'); el.hidden = false; }
      return false;
    }).catch(function () {
      var el = $('#metrics-error'); if (el) { el.textContent = 'Network error saving metric mapping.'; el.hidden = false; }
      return false;
    });
  }

  // ── STEP 4: DASHBOARD ─────────────────────────────────────
  function renderStep4() {
    var body = $('#step-4-body');
    var main = state.dashboard.mainBlocks || [];
    function isMinimal(b) { return b && MINIMAL_DASH_TYPES.indexOf(b.type) > -1; }
    function names(list) {
      var seen = {}, out = [];
      list.forEach(function (b) { var n = BLOCK_NAMES[b && b.type] || (b && b.type); if (n && !seen[n]) { seen[n] = true; out.push(n); } });
      return out;
    }
    // A small picture of the layout: every block of the seeded dashboard,
    // with the ones this option keeps highlighted.
    function mini(keep) {
      var cells = main.map(function (b) {
        if (!b) return '';
        var x = (b.gridX || 0) + 1, y = (b.gridY || 0) + 1, w = b.gridW || 12, h = Math.max(1, b.gridH || 4);
        return '<span class="' + (keep(b) ? 'is-kept' : '') + '" style="grid-column:' + x + ' / span ' + w + ';grid-row:' + y + ' / span ' + h + '"></span>';
      }).join('');
      return '<div class="wz-mini" aria-hidden="true">' + cells + '</div>';
    }
    function option(value, title, desc, list, keep) {
      var on = state.dashboard.choice === value;
      return '<label class="wz-choice' + (on ? ' is-on' : '') + '">'
        + '<input type="radio" name="dash-choice" value="' + value + '" data-action="choose-dashboard" data-layout="' + value + '"' + (on ? ' checked' : '') + '>'
        + '<span class="wz-choice-head"><span class="wz-radio"></span><strong>' + esc(title) + '</strong><span class="wz-chip">' + list.length + ' cards</span></span>'
        + mini(keep)
        + '<p>' + esc(desc) + '</p>'
        + '<span class="wz-chips">' + names(list).map(function (n) { return '<span class="wz-chip">' + esc(n) + '</span>'; }).join('') + '</span>'
        + '</label>';
    }
    if (!main.length) {
      body.innerHTML = alertBox('info', 'There\'s no starter dashboard on this server, so your dashboard starts empty. Add cards in the layout editor after setup.');
      return;
    }
    body.innerHTML = '<div class="wz-choices" role="radiogroup" aria-label="Starting dashboard">'
      + option('full', 'Everything', 'System overview, today\'s totals, energy charts, forecast, grid, savings and history. Remove what you don\'t need later.', main, function () { return true; })
      + option('minimal', 'Simple', 'Just the system overview, today\'s totals and your savings.', main.filter(isMinimal), isMinimal)
      + '</div>';
  }

  function saveDashboard() {
    var main = state.dashboard.mainBlocks.slice();
    var chosen;
    if (state.dashboard.choice === 'minimal') {
      chosen = main.filter(function (b) { return b && MINIMAL_DASH_TYPES.indexOf(b.type) > -1; });
    } else {
      chosen = main;
    }
    if (!Array.isArray(chosen)) chosen = [];
    // Persist the ARRAY shape via the canonical /api/dashboard-config path so getDashboardConfig()
    // (which requires dashboard_layouts to be an array of {id,name,layout}) reads the chosen starter.
    return api('/api/dashboard-config').then(function (res) {
      var config = (res.data && res.data.dashboards) ? res.data : { dashboards: [], activeDashboard: 'main' };
      if (!Array.isArray(config.dashboards)) config.dashboards = [];
      var mainDash = null;
      for (var i = 0; i < config.dashboards.length; i++) {
        if (config.dashboards[i] && config.dashboards[i].id === 'main') { mainDash = config.dashboards[i]; break; }
      }
      if (mainDash) {
        mainDash.layout = chosen;
      } else {
        config.dashboards.push({ id: 'main', name: 'Main', layout: chosen });
      }
      config.activeDashboard = 'main';
      return api('/api/dashboard-config', { method: 'POST', body: JSON.stringify(config) });
    }).then(function (res) {
      if (res.ok) return true;
      setGlobalError('Could not save the dashboard layout (' + (res.status || 'network') + ').');
      return false;
    }).catch(function () {
      setGlobalError('Network error saving the dashboard layout.');
      return false;
    });
  }

  // ── STEP 5: BASICS ────────────────────────────────────────
  function renderStep5() {
    var body = $('#step-5-body');
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var b = state.basics;
    body.innerHTML = '<div class="wz-card"><div class="wz-card-body">'
      + field('Dashboard title', inp('basics.dashboard_title', b.dashboard_title, { placeholder: 'My Solar', id: 'basics-title' }), { forId: 'basics-title', hint: 'Shown at the top of the dashboard.' })
      + grid(
        field('Currency symbol', inp('basics.savings_currency', b.savings_currency, { placeholder: '€', id: 'basics-currency', attrs: ' maxlength="4"' }), { forId: 'basics-currency', hint: 'For savings, e.g. €, $, £ or ₦.' }),
        (b.arrays && b.arrays.length > 1
          ? field('Solar arrays', '<p class="wz-static">' + b.arrays.length + ' arrays, ' + (+b.arrays.reduce(function (t, a) { return t + Number(a.kwp); }, 0).toFixed(2)) + ' kWp in total</p>', { hint: 'Change them in Settings › Forecast and weather › Panels.' })
          : field('Solar array size (kWp)', inp('basics.solar_capacity_kwp', b.solar_capacity_kwp, { type: 'number', id: 'basics-kwp', attrs: ' step="0.01" min="0"' }), { forId: 'basics-kwp', optional: true, hint: 'Total panel capacity, for the solar forecast. Leave it empty if you have no solar or don\'t know yet.' }))
      )
      + '</div></div>'
      + '<div class="wz-card"><div class="wz-card-body wz-row-between">'
      + '<div><div class="wz-label">Theme</div><p class="wz-hint">For this browser. Each device remembers its own.</p></div>'
      + '<div class="wz-seg" role="radiogroup" aria-label="Theme">'
      + '<button type="button" role="radio" data-action="set-theme" data-theme="light" aria-checked="' + (theme === 'light') + '">' + icon('sun', 16) + 'Light</button>'
      + '<button type="button" role="radio" data-action="set-theme" data-theme="dark" aria-checked="' + (theme === 'dark') + '">' + icon('moon', 16) + 'Dark</button>'
      + '</div></div></div>'
      + '<div class="wz-alert is-error" id="basics-error" role="alert" hidden></div>';
  }

  function saveBasics() {
    if (!basicsValid()) { var el = $('#basics-error'); if (el) { el.textContent = 'Fill in the title and currency to continue. The array size, if you give one, must be a number.'; el.hidden = false; } return Promise.resolve(false); }
    var b = state.basics;
    var payload = { savings_currency: b.savings_currency, dashboard_title: b.dashboard_title };
    var cap = String(b.solar_capacity_kwp == null ? '' : b.solar_capacity_kwp).trim();
    if (!(b.arrays && b.arrays.length > 1) && cap !== '') {
      payload.solar_capacity_kwp = Number(cap);
      // One saved array: the forecast reads the list, so keep it in step.
      if (b.arrays && b.arrays.length === 1) payload.solar_arrays = JSON.stringify([Object.assign({}, b.arrays[0], { kwp: Number(cap) })]);
    }
    return api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
      if (res.ok) return true;
      var el = $('#basics-error'); if (el) { el.textContent = 'Could not save basics (' + (res.status || 'network') + '): ' + apiErrMsg(res, 'Server'); el.hidden = false; }
      return false;
    }).catch(function () {
      var el = $('#basics-error'); if (el) { el.textContent = 'Network error saving basics.'; el.hidden = false; }
      return false;
    });
  }

  // ── STEP 6: OPTIONAL (skippable) ──────────────────────────
  function renderStepOptional() {
    var body = $('#step-6-body');
    var o = state.optional;
    var pv = o.pvoutput, fc = o.forecast, nw = o.network;
    var pvOn = truthy(pv.enabled), fcOn = truthy(fc.enabled);
    function extraCard(key, iconName, title, sub, toggle, inner, on) {
      return '<section class="wz-card" data-extra="' + key + '">'
        + '<header class="wz-card-head"><span class="wz-icon-tile">' + icon(iconName) + '</span>'
        + '<div class="wz-card-head-text"><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div>'
        + '<span class="wz-pill" data-badge-src="' + key + '" hidden></span>'
        + toggle + '</header>'
        + '<div data-extra-body="' + key + '"' + (on ? '' : ' hidden') + '>'
        + '<div class="wz-card-body">' + inner + '<div data-error="' + key + '"></div></div>'
        + '<footer class="wz-card-foot"><button class="wz-btn wz-btn-sm" type="button" data-action="test" data-source="' + key + '">Test</button></footer>'
        + '</div></section>';
    }
    function sw(path, on, label) {
      return '<label class="wz-switch"><input type="checkbox" data-field="' + path + '"' + (on ? ' checked' : '') + ' aria-label="' + esc(label) + '"><span></span></label>';
    }
    var html = extraCard('pvoutput', 'upload', 'PVOutput', 'Upload your production to pvoutput.org.',
      sw('optional.pvoutput.enabled', pvOn, 'Upload to PVOutput'),
      grid(
        field('System ID', inp('optional.pvoutput.system_id', pv.system_id, { placeholder: '12345' })),
        field('API key', inp('optional.pvoutput.api_key', pv.api_key, { type: 'password', attrs: ' autocomplete="off"' }))
      )
      + grid(
        field('Time zone', inp('optional.pvoutput.timezone', pv.timezone, { placeholder: 'e.g. Africa/Lagos' })),
        field('Upload every', sel('optional.pvoutput.upload_interval_minutes', [['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes']], pv.upload_interval_minutes))
      )
      + grid(
        field('System size (W)', inp('optional.pvoutput.system_size_w', pv.system_size_w, { type: 'number' })),
        field('Webhook URL', inp('optional.pvoutput.webhook_url', pv.webhook_url, { type: 'url' }), { optional: true })
      )
      + '<p class="wz-hint">Choose which readings are uploaded in Settings → Uploads.</p>', pvOn);

    html += extraCard('forecast', 'sun', 'Solar forecast', 'Predict today\'s and tomorrow\'s production from the weather.',
      sw('optional.forecast.enabled', fcOn, 'Solar forecast'),
      grid(
        field('Latitude', inp('optional.forecast.latitude', fc.latitude, { placeholder: 'e.g. 6.52' })),
        field('Longitude', inp('optional.forecast.longitude', fc.longitude, { placeholder: 'e.g. 3.38' }))
      )
      + '<p class="wz-hint" style="margin:-8px 0 16px"><button class="wz-btn-link" type="button" data-action="locate">Use this device\'s location</button></p>'
      + '<div class="wz-grid wz-grid-3">'
      + field('Panel tilt (°)', inp('optional.forecast.tilt', fc.tilt, { type: 'number' }), { hint: '0 is flat' })
      + field('Panel direction (°)', inp('optional.forecast.azimuth', fc.azimuth, { type: 'number' }), { hint: '180 faces south' })
      + field('Loss factor', inp('optional.forecast.loss_factor', fc.loss_factor, { type: 'number', attrs: ' step="0.01"' }), { hint: '0.9 is typical' })
      + '</div>'
      + grid(
        field('Solcast API key', inp('optional.forecast.solcast_api_key', fc.solcast_api_key, { type: 'password', attrs: ' autocomplete="off"' }), { optional: true }),
        field('Solcast site ID', inp('optional.forecast.solcast_resource_id', fc.solcast_resource_id), { optional: true })
      )
      + '<p class="wz-hint">' + (state.basics.arrays && state.basics.arrays.length > 1 ? 'Uses your ' + state.basics.arrays.length + ' PV arrays from Settings.' : String(state.basics.solar_capacity_kwp || '').trim() ? 'Uses the array size from Basics (' + esc(state.basics.solar_capacity_kwp) + ' kWp).' : 'Needs the array size: add it in Basics, or later in Settings.') + ' Without Solcast, Epilykos uses the free Open-Meteo forecast.</p>', fcOn);

    html += extraCard('network', 'wifi', 'App addresses', 'So the installed app finds Epilykos at home and away.',
      '',
      field('Address at home', inp('optional.network.local_url', nw.local_url, { type: 'url', placeholder: 'http://192.168.1.10:3000' }), { optional: true })
      + field('Address away from home', inp('optional.network.remote_url', nw.remote_url, { type: 'url', placeholder: 'https://solar.example.com' }), { optional: true })
      + '<p class="wz-hint">The app uses whichever answers first.</p>', true);

    body.innerHTML = html;
  }

  function truthy(v) { return v === true || v === 'true' || v === '1'; }

  function pvoutputConfig() {
    var pv = state.optional.pvoutput;
    return JSON.stringify({
      enabled: truthy(pv.enabled),
      api_key: pv.api_key,
      system_id: pv.system_id,
      timezone: pv.timezone,
      upload_interval_minutes: parseInt(pv.upload_interval_minutes, 10) || 5,
      system_size_w: parseInt(pv.system_size_w, 10) || 0,
      net_mode: truthy(pv.net_mode),
      webhook_url: pv.webhook_url,
      // Issue #117 (D6/AC-11): re-emit the existing metric_map so the
      // wizard's wholesale config replace cannot drop the unit selection.
      metric_map: pv.metric_map || {}
    });
  }

  // Saves all three extras. Best-effort: a failure is reported but never
  // blocks the wizard. The array size (solar_capacity_kwp) belongs to Basics
  // and isn't sent here, so skipping extras can't blank it.
  function saveOptional() {
    var fc = state.optional.forecast, nw = state.optional.network;
    var failed = [];
    var forecast = api('/api/settings', { method: 'POST', body: JSON.stringify({
      forecast_enabled: truthy(fc.enabled) ? 'true' : 'false',
      solar_latitude: fc.latitude,
      solar_longitude: fc.longitude,
      solar_tilt: fc.tilt,
      solar_azimuth: fc.azimuth,
      solcast_api_key: fc.solcast_api_key,
      solcast_resource_id: fc.solcast_resource_id,
      solar_loss_factor: fc.loss_factor
    }) }).then(function (res) { if (!res.ok) failed.push('solar forecast'); });
    var network = api('/api/settings/network', { method: 'POST', body: JSON.stringify({ network_local_url: nw.local_url, network_remote_url: nw.remote_url }) })
      .then(function (res) { if (!res.ok) failed.push('app addresses'); });
    var pvoutput = api('/api/settings/data-sources', { method: 'POST', body: JSON.stringify({ pvoutput_config: pvoutputConfig() }) })
      .then(function (res) { if (!res.ok) failed.push('PVOutput'); });
    return Promise.all([forecast, network, pvoutput]).then(function () { return failed; }, function () { return ['extras']; });
  }





  // ── STEP 7: FINISH ────────────────────────────────────────
  var SKIPPED_NOTE = {
    2: 'Add sources in Settings → Sources.',
    3: 'Match readings to roles in Settings → Metrics.',
    4: 'The starter dashboard is unchanged. Edit it in the layout editor.',
    5: 'Defaults are used. Change them in Settings → Appearance and Savings.',
    6: 'Set these up in Settings when you need them.'
  };
  function renderStepFinish() {
    var body = $('#step-7-body');
    if (state.completed) { body.innerHTML = finishDone(); return; }
    var src = SOURCE_KEYS.filter(function (k) { return state.sources[k].selected; });
    var srcText = src.map(function (k) {
      var s = state.sources[k];
      return esc(s.name || sourceType(k).name);
    }).join(', ');
    var mapped = ROLES.length - unassignedCount();
    var extras = [];
    if (truthy(state.optional.pvoutput.enabled)) extras.push('PVOutput upload');
    if (truthy(state.optional.forecast.enabled)) extras.push('solar forecast');
    if (state.optional.network.local_url || state.optional.network.remote_url) extras.push('app addresses');
    if (extras.length) extras[0] = extras[0].charAt(0).toUpperCase() + extras[0].slice(1);
    function row(iconName, title, text, step) {
      if (step && state.skipped[step]) text = '<em>Skipped.</em> ' + SKIPPED_NOTE[step];
      return '<li' + (step && state.skipped[step] ? ' class="is-skipped"' : '') + '><span class="wz-icon-tile">' + icon(iconName) + '</span><span class="wz-summary-text"><strong>' + esc(title) + '</strong><span>' + text + '</span></span>'
        + (step ? '<button class="wz-btn-link" type="button" data-action="goto-step" data-step="' + step + '">Edit</button>' : '') + '</li>';
    }
    body.innerHTML = '<div class="wz-card"><ul class="wz-summary">'
      + (state.isReRun ? '' : row('key', 'Admin password', 'Set', null))
      + row('plug', state.skipped[2] ? 'Sources' : src.length + ' source' + (src.length === 1 ? '' : 's'), srcText || 'None', 2)
      + row('list', 'Metric roles', mapped + ' of ' + ROLES.length + ' matched', 3)
      + row('layout', 'Dashboard', state.dashboard.choice === 'minimal' ? 'Simple' : 'Everything', 4)
      + row('sliders', state.skipped[5] ? 'Basics' : (state.basics.dashboard_title || 'Dashboard'), esc(state.basics.savings_currency) + (state.basics.arrays && state.basics.arrays.length > 1 ? ' · ' + state.basics.arrays.length + ' PV arrays' : String(state.basics.solar_capacity_kwp || '').trim() ? ' · ' + esc(state.basics.solar_capacity_kwp) + ' kWp' : ''), 5)
      + row('sun', 'Extras', extras.length ? esc(extras.join(', ')) : 'None', 6)
      + '</ul></div>';
  }
  // A source is configured on the server: saved in this run, or already there.
  function hasSavedSource() {
    if (!state.skipped[2] && selectedSourcesCount() > 0) return true;
    var ex = state.existing || {};
    return ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices', 'modbus_devices', 'bms_devices', 'external_sources'].some(function (k) {
      var v = ex[k]; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
      return Array.isArray(v) && v.length > 0;
    }) || !!(state.status && state.status.hasDataSource);
  }
  function finishDone() {
    return '<div class="wz-card"><div class="wz-done">'
      + '<span class="wz-state-icon is-ok">' + icon('check', 28) + '</span>'
      + '<h2>You\'re all set</h2>'
      + '<p>' + (hasSavedSource() ? 'Epilykos is reading your sources. Readings and charts fill in over the next few minutes.' : 'No sources yet. Add one in Settings → Sources and readings start to appear.') + '</p>'
      + '<div class="wz-actions"><a href="/" class="wz-btn wz-btn-primary">Open dashboard</a><a href="/editor" class="wz-btn">Edit the layout</a><a href="/settings" class="wz-btn">Settings</a></div>'
      + '</div></div>';
  }

  function completeWizard() {
    setBusy(true);
    var next = $('#next-btn'); if (next) next.classList.add('is-busy');
    api('/api/wizard/complete', { method: 'POST', body: '{}' }).then(function (res) {
      setBusy(false);
      if (next) next.classList.remove('is-busy');
      if (res.ok && res.data && res.data.success) {
        state.completed = true;
        state.status.completed = true;
        var p = $('.wizard-panel.active');
        if (p) { $('[data-step-eyebrow]', p).textContent = ''; $('[data-step-title]', p).textContent = 'Setup complete'; $('[data-step-lede]', p).textContent = ''; }
        $('#wizard').classList.add('is-complete');
        renderStepFinish();
        renderStepper();
        updateNav();
        setGlobalError(null);
      } else {
        setGlobalError('Couldn\'t finish setup (error ' + (res.status || 'network') + '). Try again.');
      }
    }).catch(function () {
      setBusy(false);
      if (next) next.classList.remove('is-busy');
      setGlobalError('Network error while finishing setup. Try again.');
    });
  }

  // ── Busy handling ─────────────────────────────────────────
  function setBusy(b) {
    state.busy = b;
    var next = $('#next-btn'); if (next) next.disabled = b || !canGoNext(state.currentStep);
    var back = $('#back-btn'); if (back) back.disabled = b;
    var skip = $('#skip-btn'); if (skip) skip.disabled = b;
  }

  // ── Field change side-effects ─────────────────────────────
  function afterFieldChange(field) {
    if (field === 'sources.dongle.profile') onDongleProfileChange(state.sources.dongle.profile, true);
    else if (field === 'sources.dongle.link') syncDongleLink();
    else if (field === 'sources.rs232.profile') onRs232ProfileChange(state.sources.rs232.profile, true);
    else if (field === 'sources.rs232.portChoice') syncCustomGroup();
    else if (field === 'sources.modbusSerial.profile' || field === 'sources.modbusTcp.profile') {
      var kind = field.split('.')[1];
      state.sources[kind].mappings = {}; state.sources[kind].entities = []; state.sources[kind].entitiesFor = null;
      loadProfileEntities(kind);
      if (kind === 'modbusTcp') syncModbusGateway();
    }
    else if (field === 'sources.bmsWired.profile') { loadBmsWiredFields(); applyBmsWiredProfile(true); updateBmsWiredProfileNotes(); }
    else if (field === 'optional.pvoutput.enabled' || field === 'optional.forecast.enabled') {
      var extra = field.split('.')[1];
      var box = document.querySelector('[data-extra-body="' + extra + '"]');
      if (box) box.hidden = !truthy(getPath(state, field));
    }
    else if (/^password\./.test(field)) syncPasswordReqs();
  }

  // ── Event delegation ──────────────────────────────────────
  function bindEvents() {
    var wiz = $('#wizard');

    function onField(e) {
      var t = e.target;
      if (t.matches('[data-field]')) {
        var field = t.getAttribute('data-field');
        setPath(state, field, t.type === 'checkbox' ? t.checked : t.value);
        afterFieldChange(field);
        // The Bluetooth timing hint under More inverters follows Read every.
        if (field === 'sources.dongle.poll_interval' && $('#dongle-bt-interval-hint')) { var dm = $('#dongle-more'); if (dm) dm.outerHTML = moreInvertersHtml('dongle'); }
        updateTestButtons();
        updateNav();
        var f = t.closest('.wz-field'); if (f) f.classList.remove('has-error');
      }
      if (t.matches('[data-combine-offer]')) { state.combineOffers = state.combineOffers || {}; state.combineOffers[t.getAttribute('data-combine-offer')] = t.checked; renderEnergyOffers(); }
      if (t.matches('[data-energy-offer]')) { state.energyOffers = state.energyOffers || {}; state.energyOffers[t.getAttribute('data-energy-offer')] = t.checked; }
      if (t.matches('[data-metric-role]')) {
        var role = t.getAttribute('data-metric-role');
        state.roleMetrics[role] = t.value;
        syncRoleWarning(t);
        renderCombineOffers();
        renderEnergyOffers();
        updateNav();
      }
      if (e.type === 'change' && t.matches('[data-source-pick]')) toggleSource(t.getAttribute('data-source-pick'), t.checked);
      if (e.type === 'change' && t.matches('[data-action="choose-dashboard"]')) chooseDashboard(t);
    }
    wiz.addEventListener('input', onField);
    wiz.addEventListener('change', onField);

    wiz.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el || el.matches('input')) return;
      var action = el.getAttribute('data-action');
      if (action === 'test') runTest(el.getAttribute('data-source'));
      else if (action === 'browse-topics') runBrowseTopics();
      else if (action === 'toggle-topic') toggleTopic(el);
      else if (action === 'regenerate') regeneratePassword();
      else if (action === 'copy-password') copyPassword(el);
      else if (action === 'reveal') revealPassword(el);
      else if (action === 'password-submit') submitPassword();
      else if (action === 'set-theme') applyTheme(el.getAttribute('data-theme'));
      else if (action === 'reset-sources') resetSources();
      else if (action === 'unselect-source') toggleSource(el.getAttribute('data-source'), false);
      else if (action === 'ble-scan') runBleScan(el.getAttribute('data-source'), el);
      else if (action === 'add-inverter' || action === 'remove-inverter') {
        var kind = el.getAttribute('data-source') || 'dongle', dg = state.sources[kind]; dg.more = dg.more || [];
        if (action === 'add-inverter') {
          if (kind === 'dongle' && !(dg.prefix || '').trim()) dg.prefix = 'inv1_';
          var used = {}; [dg.prefix].concat(dg.more.map(function (m) { return m.prefix; })).forEach(function (p) { used[String(p || '').toLowerCase()] = true; });
          var n = dg.more.length + 2; while (used['inv' + n + '_']) n++;
          dg.more.push({ name: 'Inverter ' + n, prefix: 'inv' + n + '_', ble_address: '', host: '', port: dg.port || '', unit: kind === 'modbusSerial' ? String(n) : '', serial_path: '' });
        } else dg.more.splice(Number(el.getAttribute('data-i')), 1);
        var card = $('#' + kind + '-more'); if (card) card.outerHTML = moreInvertersHtml(kind);
        var pf = document.querySelector('[data-field="sources.dongle.prefix"]'); if (pf) pf.value = dg.prefix || '';
        updateNav();
      }
      else if (action === 'ble-pick') pickBleDevice(el.getAttribute('data-source'), el.getAttribute('data-address'));
      else if (action === 'locate') useDeviceLocation(el);
      else if (action === 'goto-step') {
        var n = parseInt(el.getAttribute('data-step'), 10);
        if (!state.busy && !state.completed && n < state.currentStep) gotoStep(n);
      }
    });
    // Enter in the password step submits it.
    wiz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && state.authGated && e.target.matches('#step-1-body input')) { e.preventDefault(); submitPassword(); }
    });

    $('#back-btn').addEventListener('click', function () { if (!state.busy) gotoStep(state.currentStep - 1); });
    $('#next-btn').addEventListener('click', function () { if (!state.busy) onNext(); });
    $('#skip-btn').addEventListener('click', function () { if (!state.busy) skipStep(); });
  }

  function toggleSource(key, on) {
    var s = state.sources[key];
    if (!s) return;
    s.selected = !!on;
    syncSourceCardVisibility();
    updateTestButtons();
    loadSourceCatalog();
    updateNav();
    setNavHint('');
    if (on) {
      var card = document.querySelector('.source-config[data-source="' + key + '"]');
      if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function regeneratePassword() {
    var pw = randomString(16);
    setPath(state, 'password.newPw', pw);
    setPath(state, 'password.confirmPw', pw);
    ['pw-new', 'pw-confirm'].forEach(function (id) { var el = $('#' + id); if (el) { el.value = pw; el.type = 'text'; } });
    $$('[data-action="reveal"]').forEach(function (b) { b.setAttribute('aria-pressed', 'true'); b.setAttribute('aria-label', 'Hide password'); b.innerHTML = icon('eyeOff', 18); });
    var copy = $('#pw-copy'); if (copy) copy.hidden = false;
    var msg = $('#pw-msg'); if (msg) msg.textContent = 'Generated a 16-character password. Copy it somewhere safe before you continue.';
    syncPasswordReqs();
    updateNav();
  }
  function copyPassword(btn) {
    var pw = state.password.newPw;
    if (!pw || !navigator.clipboard) return;
    navigator.clipboard.writeText(pw).then(function () {
      btn.innerHTML = icon('check', 16) + 'Copied';
      setTimeout(function () { btn.innerHTML = icon('copy', 16) + 'Copy'; }, 2000);
    }).catch(function () {});
  }
  function revealPassword(btn) {
    var input = $('#' + btn.getAttribute('data-target'));
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.innerHTML = icon(show ? 'eyeOff' : 'eye', 18);
  }
  function useDeviceLocation(btn) {
    if (!navigator.geolocation) { setError('forecast', 'This browser can\'t share its location. Type the coordinates instead.'); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      setFieldValue('optional.forecast.latitude', pos.coords.latitude.toFixed(4));
      setFieldValue('optional.forecast.longitude', pos.coords.longitude.toFixed(4));
      clearError('forecast');
    }, function () {
      btn.disabled = false;
      setError('forecast', 'Couldn\'t get this device\'s location. Type the coordinates instead.');
    }, { timeout: 10000 });
  }

  function syncRoleWarning(input) {
    var body = $('#step-3-body');
    var key = input.getAttribute('data-metric-role');
    var warn = $('[data-role-warn="' + key + '"]');
    if (!warn || !body) return;
    var v = input.value.trim();
    var show = v && body._hasSuggestions && !(body._known || {})[v];
    warn.hidden = !show;
    if (show) warn.textContent = 'None of your sources has a reading called “' + v + '” yet.';
  }

  function chooseDashboard(input) {
    state.dashboard.choice = input.getAttribute('data-layout');
    $$('.wz-choice').forEach(function (o) { o.classList.toggle('is-on', o.contains(input)); });
    updateNav();
  }


  // ── NEXT ──────────────────────────────────────────────────
  function onNext() {
    if (state.busy) return;
    var step = state.currentStep;
    if (step === 1) { submitPassword(); return; }
    if (step === LAST_STEP) {
      if (state.completed) { window.location.href = '/'; return; }
      completeWizard();
      return;
    }
    setNavHint('');
    var next = $('#next-btn');
    setBusy(true);
    if (next) next.classList.add('is-busy');
    var done = function () { setBusy(false); if (next) next.classList.remove('is-busy'); };
    var proceed = function () { done(); delete state.skipped[step]; gotoStep(step + 1); };
    var stay = function (msg) { done(); updateNav(); if (msg) setNavHint(msg, true); };
    if (step === 2 && selectedSourcesCount() === 0) {
      // Nothing picked: same as Skip, no sources are saved.
      done(); skipStep(); return;
    }
    if (step === 2) {
      saveSources().then(function (ok) {
        if (ok) { proceed(); return; }
        stay('Some connection details are missing.');
        var first = $('#step-2-body [data-error].wz-alert');
        var card = first && first.closest('.source-config');
        if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); var inp = $('input, select', card); if (inp) inp.focus({ preventScroll: true }); }
      });
    } else if (step === 3) {
      saveRoleMetrics().then(function (ok) { if (ok) proceed(); else stay('Couldn\'t save the roles.'); });
    } else if (step === 4) {
      saveDashboard().then(function (ok) { if (ok) proceed(); else stay(); });
    } else if (step === 5) {
      saveBasics().then(function (ok) { if (ok) proceed(); else stay('Check the highlighted fields.'); });
    } else if (step === 6) {
      // Extras never block: report anything that didn't save, then move on.
      saveOptional().then(function (failed) {
        proceed();
        if (failed && failed.length) setGlobalError('Couldn\'t save ' + failed.join(', ') + '. You can set ' + (failed.length > 1 ? 'them' : 'it') + ' in Settings.');
      });
    } else {
      proceed();
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    hydrateIcons(document);
    bindEvents();
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
