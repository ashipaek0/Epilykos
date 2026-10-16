/**
 * Settings → Notifications. Self-contained: talks to /api/notifications and
 * saves each change on its own (the section sits outside the settings form
 * and the save bar). Loaded after settings-shell.js (window.stShell).
 *
 *   General   on/off, quiet hours, dashboard address for links
 *   Devices   web push on this browser + every subscribed device
 *   Channels  Telegram, Discord, ntfy, push (to all or chosen devices)
 *   Rules     any metric (threshold, equals, changes, stale), any event, or a
 *             scheduled report (daily summary, forecast, status)
 *   History   delivery log
 */
(function () {
  'use strict';

  var root = document.getElementById('nt-root');
  if (!root) return;
  var shell = window.stShell || {};
  var esc = shell.esc || function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }

  var state = null;          // GET /state
  var metrics = [];          // /api/metrics/list
  var log = [];
  var thisDevice = { supported: false, reason: '', hash: null, permission: 'default' };
  var editChannel = null;    // { id|null, type, draft }
  var editRule = null;       // { id|null, draft }
  var loaded = false;

  var TYPE_LABEL = { telegram: 'Telegram', discord: 'Discord', ntfy: 'ntfy', webpush: 'Push to devices', webhook: 'Webhook' };
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_LABEL = { today: 'today', yesterday: 'yesterday', tomorrow: 'tomorrow' };
  var SEVERITY_LABEL = { info: 'Info', warning: 'Warning', critical: 'Critical' };

  // ── API ──────────────────────────────────────────────────────────────
  async function api(method, path, body) {
    var res = await fetch('/api/notifications' + path, {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  async function load() {
    try {
      var results = await Promise.all([
        api('GET', '/state'),
        fetch('/api/metrics/list', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
        api('GET', '/log?limit=50').catch(function () { return []; })
      ]);
      state = results[0];
      metrics = (Array.isArray(results[1]) ? results[1] : []).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      log = results[2] || [];
      await detectDevice();
      loaded = true;
      render();
    } catch (e) {
      root.innerHTML = '<div class="st-card"><p class="st-help">Could not load notifications: ' + esc(e.message) + '</p><button type="button" class="st-btn" data-act="reload">Try again</button></div>';
    }
  }

  async function refreshLog() {
    try { log = await api('GET', '/log?limit=50'); } catch (e) { /* keep old */ }
    var el = document.getElementById('nt-history');
    if (el) el.outerHTML = historyCard();
  }

  // ── This device (web push) ───────────────────────────────────────────
  function isIos() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function isStandalone() { return window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); }

  async function sha256Hex(text) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  async function swRegistration() {
    var reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) reg = await navigator.serviceWorker.register('/sw.js');
    return navigator.serviceWorker.ready.then(function () { return reg; });
  }

  async function detectDevice() {
    thisDevice = { supported: false, reason: '', hash: null, permission: (window.Notification && Notification.permission) || 'default' };
    if (!window.isSecureContext) { thisDevice.reason = 'insecure'; return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.Notification) {
      thisDevice.reason = isIos() && !isStandalone() ? 'ios-homescreen' : 'unsupported';
      return;
    }
    thisDevice.supported = true;
    try {
      var reg = await swRegistration();
      var sub = await reg.pushManager.getSubscription();
      if (sub) thisDevice.hash = await sha256Hex(sub.endpoint);
    } catch (e) { /* no subscription yet */ }
  }

  function currentDevice() {
    if (!state || !thisDevice.hash) return null;
    return state.devices.find(function (d) { return d.endpoint_hash === thisDevice.hash; }) || null;
  }

  function b64ToBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function enablePush() {
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser settings, then try again.' : 'Permission was not given.', 'error'); return; }
    var reg = await swRegistration();
    var key = b64ToBytes(state.vapidPublicKey);
    var sub = await reg.pushManager.getSubscription();
    if (sub) {
      // A subscription made with other server keys (an old install) cannot be reused.
      var existing = sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (existing && existing.join(',') !== key.join(',')) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    var label = (document.getElementById('nt-device-label') || {}).value || '';
    var out = await api('POST', '/devices', { subscription: sub.toJSON(), label: label.trim() });
    toast(out.channel ? 'Push is on for this device. A "' + out.channel.name + '" channel was added for your rules.' : 'Push is on for this device.');
    await load();
  }

  async function disablePush(id) {
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      var sub = reg && await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) { /* the server side is what matters */ }
    if (id) await api('DELETE', '/devices/' + encodeURIComponent(id));
    toast('Push is off for this device.');
    await load();
  }

  // ── Small view helpers ───────────────────────────────────────────────
  function fmtTime(ts) { return ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
  function pill(text, tone) { return '<span class="st-pill is-' + tone + '"><span class="st-pill-dot"></span>' + esc(text) + '</span>'; }
  function sevBadge(sev) { return '<span class="st-badge nt-sev-' + esc(sev || 'event') + '">' + esc(SEVERITY_LABEL[sev] || 'Event\'s own') + '</span>'; }
  function toggle(id, checked, label, extra) {
    return '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + (extra || '') + '><span class="slider"></span></label><label for="' + id + '">' + esc(label) + '</label></span>';
  }
  /** One switch in a multi-select list (name/value like a checkbox group). */
  function toggleItem(name, value, on, label, sub) {
    var id = name + '-' + String(value).replace(/[^\w-]/g, '_');
    return '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="' + id + '" name="' + name + '" value="' + esc(value) + '"' + (on ? ' checked' : '') + '><span class="slider"></span></label>' +
      '<label for="' + id + '">' + esc(label) + (sub ? ' <span class="nt-muted">' + esc(sub) + '</span>' : '') + '</label></span>';
  }
  function toggleList(name, items, legend, cls) {
    return '<fieldset class="nt-fieldset"><legend>' + esc(legend) + '</legend><div class="nt-toggle-list' + (cls ? ' ' + cls : '') + '">' + items.join('') + '</div></fieldset>';
  }
  function checkedValues(name) { return Array.prototype.map.call(root.querySelectorAll('input[name="' + name + '"]:checked'), function (x) { return x.value; }); }
  function field(id, label, input, help) {
    return '<div class="st-field"><label for="' + id + '">' + esc(label) + '</label>' + input + (help ? '<span class="st-help">' + help + '</span>' : '') + '</div>';
  }
  function input(id, value, attrs) { return '<input id="' + id + '" class="input" value="' + esc(value == null ? '' : value) + '"' + (attrs || '') + '>'; }
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }
  function channelName(id) { var c = state.channels.find(function (x) { return x.id === id; }); return c ? c.name : null; }
  function eventLabel(type) {
    if (type === '*') return 'Any event';
    var t = state.eventTypes.find(function (e) { return e.type === type; });
    if (t) return t.label;
    if (/\.\*$/.test(type)) return 'Any ' + type.slice(0, -2) + ' event';
    return type;
  }
  function opLabel(op) { var o = state.operators.find(function (x) { return x.id === op; }); return o ? o.label : op; }
  function metricInfo(name) { return metrics.find(function (m) { return m.name === name; }); }

  function ruleSummary(r) {
    var when;
    if (r.kind === 'schedule') {
      var rep = (state.reports || []).find(function (x) { return x.id === r.report; });
      when = (rep ? rep.label : r.report) + (r.day ? ' (' + DAY_LABEL[r.day] + ')' : '') + ' at ' + r.time +
        (r.days && r.days.length ? ' on ' + r.days.map(function (d) { return WEEKDAYS[d]; }).join(', ') : ' every day') +
        (r.report === 'forecast' && r.below_kwh > 0 ? ', only below ' + r.below_kwh + ' kWh' : '');
    } else if (r.kind === 'event') {
      when = 'When: ' + eventLabel(r.event) + (r.subject ? ' (' + r.subject + ')' : '');
    } else if (r.operator === 'changes') {
      when = r.metric + ' changes';
    } else if (r.operator === 'stale') {
      when = r.metric + ' has not updated for ' + r.value + ' min';
    } else {
      when = r.metric + ' ' + opLabel(r.operator) + ' ' + r.value + (r.for_s >= 60 ? ' for ' + Math.round(r.for_s / 60) + ' min' : '');
    }
    var to = (r.channels || []).map(channelName).filter(Boolean);
    return esc(when) + ' → ' + (to.length ? esc(to.join(', ')) : '<span class="nt-warn">no channels</span>');
  }

  function channelSummary(c) {
    var cfg = c.config || {};
    if (c.type === 'telegram') return 'Chat ' + esc(cfg.chat_id || '?') + (cfg.commands ? ' · answers /status' : '');
    if (c.type === 'webhook') return 'JSON POST' + (cfg.has_auth_header ? ' · with Authorization' : '');
    if (c.type === 'discord') return 'Webhook' + (cfg.mention_here ? ' · @here on critical' : '');
    if (c.type === 'ntfy') return esc((cfg.server_url || 'https://ntfy.sh').replace(/^https?:\/\//, '')) + '/' + esc(cfg.topic || '');
    if (c.type === 'webpush') {
      if (cfg.devices === 'all') return 'All devices (' + state.devices.length + ')';
      var names = (cfg.devices || []).map(function (id) { var d = state.devices.find(function (x) { return x.id === id; }); return d && d.label; }).filter(Boolean);
      return names.length ? esc(names.join(', ')) : '<span class="nt-warn">no devices</span>';
    }
    return '';
  }

  // ── Cards ────────────────────────────────────────────────────────────
  function generalCard() {
    var s = state.settings, q = s.quiet_hours || {};
    return '<div class="st-card"><div class="st-card-head"><h2>General</h2></div>' +
      '<div class="st-toggle-row">' + toggle('nt-enabled', s.enabled, 'Send notifications', ' data-general') + '</div>' +
      '<div class="st-toggle-row">' + toggle('nt-quiet', q.enabled, 'Quiet hours', ' data-general') + '</div>' +
      (q.enabled ? '<div class="st-grid-2">' +
        field('nt-quiet-start', 'Quiet from', input('nt-quiet-start', q.start, ' type="time" data-general')) +
        field('nt-quiet-end', 'Until', input('nt-quiet-end', q.end, ' type="time" data-general')) +
      '</div>' : '') +
      '<p class="st-help nt-gap">During quiet hours only critical alerts are sent; the rest are noted in History.</p>' +
      field('nt-base-url', 'Dashboard address for links', input('nt-base-url', s.base_url, ' type="url" data-general placeholder="https://energy.example.com"'), 'Telegram, Discord, ntfy and webhook messages link here. Leave empty for no link.') +
      '<p class="st-help">Changes here save on their own.</p></div>';
  }

  function devicesCard() {
    var cur = currentDevice();
    var here;
    if (!thisDevice.supported) {
      var why = {
        insecure: 'Push needs a secure (https://) address. Open Epilykos through your HTTPS address (see Network) to turn it on for this device.',
        'ios-homescreen': 'On iPhone and iPad, add Epilykos to the Home Screen (Share → Add to Home Screen), open it from there, then come back here.',
        unsupported: 'This browser does not support push notifications.'
      }[thisDevice.reason] || 'Push is not available here.';
      here = '<p class="st-help">' + esc(why) + '</p>';
    } else if (cur) {
      here = '<p class="st-help">This device gets push notifications as <strong>' + esc(cur.label) + '</strong>.</p>' +
        '<div class="st-inline-actions"><button type="button" class="st-btn" data-act="device-test" data-id="' + esc(cur.id) + '">Test</button><button type="button" class="st-btn st-btn-danger-text" data-act="push-off" data-id="' + esc(cur.id) + '">Turn off on this device</button></div>';
    } else {
      here = (thisDevice.permission === 'denied' ? '<p class="st-help nt-warn">Notifications are blocked for this site in the browser settings.</p>' : '') +
        '<div class="nt-row-form">' + field('nt-device-label', 'Name for this device', input('nt-device-label', '', ' placeholder="e.g. My phone" maxlength="60"')) +
        '<button type="button" class="st-btn st-btn-primary" data-act="push-on">Turn on push for this device</button></div>';
    }
    var list = state.devices.length ? '<ul class="nt-list">' + state.devices.map(function (d) {
      var status = d.last_error_at && (!d.last_ok_at || d.last_error_at > d.last_ok_at) ? pill('Last push failed', 'error') : (d.last_ok_at ? pill('Working', 'ok') : pill('Not used yet', 'unknown'));
      return '<li class="nt-item"><div class="nt-item-text"><span class="nt-item-name">' + esc(d.label) + (cur && cur.id === d.id ? ' <span class="nt-this">this device</span>' : '') + '</span>' +
        '<span class="nt-item-sub">' + esc(d.service) + ' · added ' + esc(fmtTime(d.created_at)) + '</span></div>' + status +
        '<div class="nt-item-actions"><button type="button" class="st-btn" data-act="device-rename" data-id="' + esc(d.id) + '">Rename</button>' +
        '<button type="button" class="st-btn" data-act="device-test" data-id="' + esc(d.id) + '">Test</button>' +
        '<button type="button" class="st-btn st-btn-danger-text" data-act="device-remove" data-id="' + esc(d.id) + '">Remove</button></div></li>';
    }).join('') + '</ul>' : '<p class="st-help">No devices yet. Turn on push on each phone, tablet or computer you want alerts on.</p>';
    return '<div class="st-card"><div class="st-card-head"><h2>Push devices</h2></div>' + here +
      '<h3 class="st-card-subhead">Subscribed devices</h3>' + list + '</div>';
  }

  function channelsCard() {
    var items = state.channels.map(function (c) {
      if (editChannel && editChannel.id === c.id) return '<li class="nt-item nt-item-editing">' + channelEditor() + '</li>';
      return '<li class="nt-item"><div class="nt-item-text"><span class="nt-item-name">' + esc(c.name) + '</span><span class="nt-item-sub">' + esc(TYPE_LABEL[c.type] || c.type) + ' · ' + channelSummary(c) + '</span></div>' +
        '<span class="toggle-wrap"><label class="toggle-switch" title="Channel on/off"><input type="checkbox" data-act="channel-toggle" data-id="' + esc(c.id) + '"' + (c.enabled ? ' checked' : '') + ' aria-label="' + esc(c.name) + ' on"><span class="slider"></span></label></span>' +
        '<div class="nt-item-actions"><button type="button" class="st-btn" data-act="channel-edit" data-id="' + esc(c.id) + '">Edit</button>' +
        '<button type="button" class="st-btn" data-act="channel-test-saved" data-id="' + esc(c.id) + '">Test</button>' +
        '<button type="button" class="st-btn st-btn-danger-text" data-act="channel-delete" data-id="' + esc(c.id) + '">Delete</button></div></li>';
    }).join('');
    var adding = editChannel && !editChannel.id ? '<div class="nt-editor-wrap">' + channelEditor() + '</div>' : '';
    return '<div class="st-card"><div class="st-card-head"><h2>Channels</h2>' +
        '<button type="button" class="st-btn st-btn-primary" data-act="channel-pick"' + (editChannel ? ' disabled' : '') + '>' + plusIcon() + 'Add channel</button></div>' +
      '<p class="st-help">Where alerts go. Each rule picks one or more channels.</p>' +
      adding + (items ? '<ul class="nt-list">' + items + '</ul>' : (adding ? '' : '<p class="st-help">No channels yet.</p>')) + '</div>';
  }

  function channelEditor() {
    var d = editChannel.draft, cfg = d.config || {}, t = editChannel.type, html = '';
    var secretHint = function (has) { return has ? ' placeholder="Saved — leave empty to keep"' : ''; };
    html += field('nt-ch-name', 'Name', input('nt-ch-name', d.name, ' maxlength="60"'));
    if (t === 'telegram') {
      html += field('nt-ch-bot', 'Bot token', input('nt-ch-bot', cfg.bot_token, ' type="password" autocomplete="off"' + secretHint(cfg.has_bot_token)),
        'Message <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> on Telegram, send /newbot and paste the token here.');
      html += '<div class="nt-row-form">' + field('nt-ch-chat', 'Chat ID', input('nt-ch-chat', cfg.chat_id, ' inputmode="numeric" placeholder="123456789"'),
        'Message your bot, or add it as an admin of your channel or group and post something there, then press Find chat. An ID copied from the Telegram app works too.') +
        '<button type="button" class="st-btn" data-act="telegram-find">Find chat</button></div><div id="nt-chats"></div>';
      html += '<div class="st-toggle-row">' + toggle('nt-ch-commands', cfg.commands, 'Answer commands in this chat') + '</div>' +
        '<p class="st-help nt-gap">Send /status, /today, /yesterday or /forecast to the bot. Only this chat gets answers.</p>';
    } else if (t === 'discord') {
      html += field('nt-ch-webhook', 'Webhook URL', input('nt-ch-webhook', cfg.webhook_url, ' type="password" autocomplete="off"' + secretHint(cfg.has_webhook_url)),
        'In Discord: channel settings → Integrations → Webhooks → New webhook → Copy webhook URL.');
      html += '<div class="st-toggle-row">' + toggle('nt-ch-here', cfg.mention_here, 'Mention @here on critical alerts') + '</div>';
    } else if (t === 'ntfy') {
      html += field('nt-ch-server', 'Server', input('nt-ch-server', cfg.server_url || 'https://ntfy.sh', ' type="url"'), 'ntfy.sh or your own server.');
      html += field('nt-ch-topic', 'Topic', input('nt-ch-topic', cfg.topic, ' maxlength="64" placeholder="epilykos-' + Math.random().toString(36).slice(2, 10) + '"'),
        'Anyone who knows a topic on ntfy.sh can read it — pick something hard to guess. Subscribe to it in the ntfy app.');
      html += field('nt-ch-token', 'Access token (optional)', input('nt-ch-token', cfg.token, ' type="password" autocomplete="off"' + secretHint(cfg.has_token)), 'For servers or topics that need a login.');
      html += '<div class="st-toggle-row">' + toggle('nt-ch-private', cfg.allow_private, 'Server is on my local network') + '</div>';
    } else if (t === 'webhook') {
      html += field('nt-ch-webhook', 'URL', input('nt-ch-webhook', cfg.webhook_url, ' type="password" autocomplete="off"' + (cfg.has_webhook_url ? ' placeholder="Saved — leave empty to keep"' : ' placeholder="https://homeassistant.local:8123/api/webhook/…"')),
        'Each alert is POSTed as JSON: source, title, message, severity, tag, url, timestamp (and event or rule). Works with Home Assistant, n8n, Node-RED and your own scripts.');
      html += field('nt-ch-auth', 'Authorization header (optional)', input('nt-ch-auth', cfg.auth_header, ' type="password" autocomplete="off"' + secretHint(cfg.has_auth_header) + (cfg.has_auth_header ? '' : ' placeholder="Bearer …"')));
      html += '<div class="st-toggle-row">' + toggle('nt-ch-private', cfg.allow_private, 'Address is on my local network') + '</div>';
    } else if (t === 'webpush') {
      var all = cfg.devices === 'all';
      html += '<div class="st-toggle-row">' + toggle('nt-ch-alldev', all, 'All devices, including ones added later', ' data-act="webpush-all"') + '</div>';
      if (!all) {
        html += state.devices.length
          ? toggleList('nt-ch-dev', state.devices.map(function (dv) { return toggleItem('nt-ch-dev', dv.id, Array.isArray(cfg.devices) && cfg.devices.indexOf(dv.id) >= 0, dv.label); }), 'Send to these devices')
          : '<p class="st-help nt-warn">No devices yet — turn on push on a device above.</p>';
      }
    }
    html += '<div class="st-toggle-row">' + toggle('nt-ch-enabled', d.enabled !== false, 'Channel on') + '</div>';
    html += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" data-act="channel-save">Save channel</button>' +
      '<button type="button" class="st-btn" data-act="channel-test">Test</button>' +
      '<button type="button" class="st-btn" data-act="channel-cancel">Cancel</button></div>';
    return '<div class="nt-editor" id="nt-channel-editor"><h3 class="nt-editor-title">' + esc((editChannel.id ? 'Edit ' : 'New ') + TYPE_LABEL[t] + ' channel') + '</h3>' + html + '</div>';
  }

  function readChannelForm() {
    var t = editChannel.type, cfg = {};
    if (t === 'telegram') { cfg.bot_token = val('nt-ch-bot').trim(); cfg.chat_id = val('nt-ch-chat').trim(); cfg.commands = checked('nt-ch-commands'); }
    if (t === 'webhook') { cfg.webhook_url = val('nt-ch-webhook').trim(); cfg.auth_header = val('nt-ch-auth').trim(); cfg.allow_private = checked('nt-ch-private'); }
    if (t === 'discord') { cfg.webhook_url = val('nt-ch-webhook').trim(); cfg.mention_here = checked('nt-ch-here'); }
    if (t === 'ntfy') { cfg.server_url = val('nt-ch-server').trim(); cfg.topic = val('nt-ch-topic').trim() || (document.getElementById('nt-ch-topic') || {}).placeholder || ''; cfg.token = val('nt-ch-token').trim(); cfg.allow_private = checked('nt-ch-private'); }
    if (t === 'webpush') cfg.devices = checked('nt-ch-alldev') ? 'all' : checkedValues('nt-ch-dev');
    return { id: editChannel.id || undefined, type: t, name: val('nt-ch-name').trim(), enabled: checked('nt-ch-enabled'), config: cfg };
  }

  // ── Rules ────────────────────────────────────────────────────────────
  function findMetric(re) { var m = metrics.find(function (x) { return re.test(x.name); }); return m ? m.name : ''; }
  function defaultChannels() { return state.channels.filter(function (c) { return c.enabled; }).map(function (c) { return c.id; }); }

  var PRESETS = {
    'grid-off': function () { return { kind: 'event', name: 'Grid outage', event: 'grid.off', severity: 'critical' }; },
    'grid-on': function () { return { kind: 'event', name: 'Grid restored', event: 'grid.on', severity: 'info' }; },
    'battery-low': function () { return { kind: 'metric', name: 'Battery low', metric: findMetric(/soc|state of charge/i), operator: 'lt', value: 20, for_s: 300, hysteresis: 5, notify_resolved: true, severity: 'warning', cooldown_s: 3600 }; },
    'source-offline': function () { return { kind: 'event', name: 'Source offline', event: 'source.*', severity: '' , cooldown_s: 1800 }; },
    'stale': function () { return { kind: 'metric', name: 'Data stopped updating', metric: findMetric(/pv power|solar power|load power/i), operator: 'stale', value: 15, notify_resolved: true, severity: 'warning', cooldown_s: 3600 }; },
    'summary': function () { return { kind: 'schedule', name: 'Evening summary', report: 'day_summary', day: 'today', time: '21:00', days: [], severity: 'info' }; },
    'low-solar': function () { return { kind: 'schedule', name: 'Low solar tomorrow', report: 'forecast', day: 'tomorrow', time: '19:00', days: [], below_kwh: 5, severity: 'warning' }; },
    'forecast-down': function () { return { kind: 'event', name: 'Forecast unavailable', event: 'forecast.unavailable', severity: '', cooldown_s: 21600 }; },
    'schedule': function () { return { kind: 'schedule', name: '', report: 'status', day: '', time: '08:00', days: [], severity: 'info' }; },
    'metric': function () { return { kind: 'metric', name: '', metric: '', operator: 'gt', value: '', for_s: 0, severity: 'warning', cooldown_s: 900 }; },
    'event': function () { return { kind: 'event', name: '', event: '', severity: '', cooldown_s: 0 }; }
  };

  function rulesCard() {
    var items = state.rules.map(function (r) {
      if (editRule && editRule.id === r.id) return '<li class="nt-item nt-item-editing">' + ruleEditor() + '</li>';
      return '<li class="nt-item"><div class="nt-item-text"><span class="nt-item-name">' + esc(r.name) + ' ' + sevBadge(r.severity) + '</span><span class="nt-item-sub">' + ruleSummary(r) + '</span></div>' +
        '<span class="toggle-wrap"><label class="toggle-switch" title="Rule on/off"><input type="checkbox" data-act="rule-toggle" data-id="' + esc(r.id) + '"' + (r.enabled ? ' checked' : '') + ' aria-label="' + esc(r.name) + ' on"><span class="slider"></span></label></span>' +
        '<div class="nt-item-actions"><button type="button" class="st-btn" data-act="rule-edit" data-id="' + esc(r.id) + '">Edit</button>' +
        '<button type="button" class="st-btn" data-act="rule-test" data-id="' + esc(r.id) + '">Test</button>' +
        '<button type="button" class="st-btn st-btn-danger-text" data-act="rule-delete" data-id="' + esc(r.id) + '">Delete</button></div></li>';
    }).join('');
    var adding = editRule && !editRule.id ? '<div class="nt-editor-wrap">' + ruleEditor() + '</div>' : '';
    return '<div class="st-card"><div class="st-card-head"><h2>Alert rules</h2>' +
        '<button type="button" class="st-btn st-btn-primary" data-act="rule-pick"' + (editRule ? ' disabled' : '') + '>' + plusIcon() + 'Add rule</button></div>' +
      '<p class="st-help">A rule watches any metric or any event, or sends a report on a schedule, to the channels you pick.</p>' +
      adding + (items ? '<ul class="nt-list">' + items + '</ul>' : (adding ? '' : '<p class="st-help">No rules yet. Add one to get alerts.</p>')) + '</div>';
  }

  function eventOptions(selected) {
    var groups = {};
    state.eventTypes.forEach(function (e) { (groups[e.category] = groups[e.category] || []).push(e); });
    var html = '<option value="">Choose an event…</option>';
    Object.keys(groups).forEach(function (g) {
      html += '<optgroup label="' + esc(g) + '">' + groups[g].map(function (e) {
        return '<option value="' + esc(e.type) + '"' + (e.type === selected ? ' selected' : '') + '>' + esc(e.label) + '</option>';
      }).join('') + '</optgroup>';
    });
    var prefixes = {};
    state.eventTypes.forEach(function (e) { prefixes[e.type.split('.')[0]] = 1; });
    html += '<optgroup label="Wildcards">' + Object.keys(prefixes).map(function (p) {
      var v = p + '.*';
      return '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>Any ' + esc(p) + ' event</option>';
    }).join('') + '<option value="*"' + (selected === '*' ? ' selected' : '') + '>Any event at all</option></optgroup>';
    return html;
  }

  function ruleEditor() {
    var d = editRule.draft, kind = d.kind || 'metric', html = '';
    html += field('nt-r-name', 'Name', input('nt-r-name', d.name, ' maxlength="80" placeholder="e.g. Battery low"'));
    html += '<div class="st-field"><span class="nt-label" id="nt-r-kind-label">Watch</span><div class="st-seg nt-seg" role="radiogroup" aria-labelledby="nt-r-kind-label">' +
      [['metric', 'A metric'], ['event', 'An event'], ['schedule', 'On a schedule']].map(function (k) {
        return '<button type="button" role="radio" data-act="rule-kind" data-kind="' + k[0] + '" aria-checked="' + (kind === k[0]) + '" tabindex="' + (kind === k[0] ? '0' : '-1') + '">' + k[1] + '</button>';
      }).join('') + '</div></div>';
    if (kind === 'metric') {
      var op = d.operator || 'gt';
      var info = metricInfo(d.metric);
      var now = info && info.value != null ? 'Now: ' + esc(info.value) + (info.unit ? ' ' + esc(info.unit) : '') : (d.metric ? 'No current value' : 'Any metric from your sources, including text ones like a grid status.');
      html += field('nt-r-metric', 'Metric', input('nt-r-metric', d.metric, ' list="nt-metric-list" autocomplete="off" placeholder="Start typing a metric name"'), '<span id="nt-r-metric-now">' + now + '</span>');
      html += '<datalist id="nt-metric-list">' + metrics.map(function (m) { return '<option value="' + esc(m.name) + '">'; }).join('') + '</datalist>';
      html += '<div class="st-grid-2">' +
        field('nt-r-op', 'Condition', '<select id="nt-r-op" class="input" data-act="rule-op">' + state.operators.map(function (o) { return '<option value="' + o.id + '"' + (o.id === op ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>') +
        (op === 'changes' ? '<div></div>' : field('nt-r-value', op === 'stale' ? 'Minutes' : 'Value', input('nt-r-value', d.value, (op === 'eq' || op === 'neq') ? ' placeholder="e.g. 20 or off"' : ' type="number" step="any"'))) +
      '</div>';
      if (op !== 'changes' && op !== 'stale') {
        html += '<div class="st-grid-2">' +
          field('nt-r-for', 'For at least (minutes)', input('nt-r-for', d.for_s ? d.for_s / 60 : 0, ' type="number" min="0" step="1"'), 'Ignores brief spikes. 0 = right away.') +
          ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') ? field('nt-r-hyst', 'Resolve margin', input('nt-r-hyst', d.hysteresis || 0, ' type="number" min="0" step="any"'), 'Below 20 with margin 5 resolves above 25.') : '<div></div>') +
        '</div>';
      }
      if (op !== 'changes') {
        html += '<div class="st-toggle-row">' + toggle('nt-r-resolved', d.notify_resolved, 'Also notify when it is back to normal') + '</div>';
        html += field('nt-r-repeat', 'Remind me every (minutes)', input('nt-r-repeat', d.repeat_s ? d.repeat_s / 60 : 0, ' type="number" min="0" step="5"'), 'While it stays active. 0 = once. At least 5.');
      }
    } else if (kind === 'schedule') {
      var reps = state.reports || [];
      var rep = reps.find(function (x) { return x.id === d.report; }) || reps[0] || { days: [] };
      html += '<div class="st-grid-2">' +
        field('nt-r-report', 'Report', '<select id="nt-r-report" class="input">' + reps.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === rep.id ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select>') +
        (rep.days.length ? field('nt-r-day', 'For', '<select id="nt-r-day" class="input">' + rep.days.map(function (dd) { return '<option value="' + dd + '"' + (dd === d.day ? ' selected' : '') + '>' + esc(DAY_LABEL[dd].charAt(0).toUpperCase() + DAY_LABEL[dd].slice(1)) + '</option>'; }).join('') + '</select>') : '<div></div>') +
      '</div>';
      html += field('nt-r-time', 'Send at', input('nt-r-time', d.time || '08:00', ' type="time"'), 'Local time on the server. Scheduled reports are sent during quiet hours too.');
      var dsel = d.days || [];
      html += toggleList('nt-r-wd', [1, 2, 3, 4, 5, 6, 0].map(function (wd) { return toggleItem('nt-r-wd', wd, !dsel.length || dsel.indexOf(wd) >= 0, WEEKDAYS[wd]); }), 'On these days', 'nt-toggle-grid');
      if (rep.id === 'forecast') {
        html += field('nt-r-below', 'Only send when the forecast is below (kWh)', input('nt-r-below', d.below_kwh || 0, ' type="number" min="0" step="0.5"'), '0 = send every time. Use it to be warned about a poor solar day ahead.');
      }
    } else {
      html += field('nt-r-event', 'Event', '<select id="nt-r-event" class="input">' + eventOptions(d.event) + '</select>', (function () {
        var t = state.eventTypes.find(function (e) { return e.type === d.event; }); return t ? esc(t.description) : '';
      })());
      html += field('nt-r-subject', 'Only for (optional)', input('nt-r-subject', d.subject, ' placeholder="e.g. modbus, or a broker address"'), 'Limit to one source or broker. Leave empty for all.');
    }
    html += '<div class="st-grid-2">' +
      field('nt-r-sev', 'Severity', '<select id="nt-r-sev" class="input">' + (kind === 'event' ? '<option value="">Use the event\'s own</option>' : '') +
        ['info', 'warning', 'critical'].map(function (s) { return '<option value="' + s + '"' + (d.severity === s ? ' selected' : '') + '>' + SEVERITY_LABEL[s] + '</option>'; }).join('') + '</select>',
        kind === 'schedule' ? '' : 'Critical alerts are sent during quiet hours too.') +
      (kind === 'schedule' ? '<div></div>' : field('nt-r-cool', 'Wait before alerting again (minutes)', input('nt-r-cool', d.cooldown_s ? d.cooldown_s / 60 : 0, ' type="number" min="0" step="1"'))) +
      '</div>';
    var chosen = d.channels || [];
    html += state.channels.length
      ? toggleList('nt-r-ch', state.channels.map(function (c) { return toggleItem('nt-r-ch', c.id, chosen.indexOf(c.id) >= 0, c.name, TYPE_LABEL[c.type] + (c.enabled ? '' : ', off')); }), 'Send to')
      : '<p class="st-help nt-warn">Add a channel first (Channels, above).</p>';
    html += field('nt-r-msg', kind === 'schedule' ? 'Note above the report (optional)' : 'Custom message (optional)', input('nt-r-msg', d.message, ' maxlength="500"'),
      { metric: 'Use {metric}, {value}, {threshold}, {previous} and {rule}.', event: 'Use {message}, {subject}, {event} and {rule}.', schedule: '' }[kind]);
    html += '<div class="st-toggle-row">' + toggle('nt-r-enabled', d.enabled !== false, 'Rule on') + '</div>';
    html += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" data-act="rule-save">Save rule</button><button type="button" class="st-btn" data-act="rule-cancel">Cancel</button></div>';
    return '<div class="nt-editor" id="nt-rule-editor"><h3 class="nt-editor-title">' + (editRule.id ? 'Edit rule' : 'New rule') + '</h3>' + html + '</div>';
  }

  /** Copy the editor's fields into editRule.draft (so a re-render keeps edits). */
  function syncRuleDraft() {
    if (!editRule || !document.getElementById('nt-rule-editor')) return editRule && editRule.draft;
    var d = editRule.draft;
    d.name = val('nt-r-name');
    d.severity = val('nt-r-sev');
    d.cooldown_s = Math.round((Number(val('nt-r-cool')) || 0) * 60);
    d.message = val('nt-r-msg');
    d.enabled = checked('nt-r-enabled');
    d.channels = checkedValues('nt-r-ch');
    if (d.kind === 'metric') {
      d.metric = val('nt-r-metric').trim();
      d.operator = val('nt-r-op') || d.operator;
      if (document.getElementById('nt-r-value')) d.value = val('nt-r-value');
      if (document.getElementById('nt-r-for')) d.for_s = Math.round((Number(val('nt-r-for')) || 0) * 60);
      if (document.getElementById('nt-r-hyst')) d.hysteresis = val('nt-r-hyst');
      if (document.getElementById('nt-r-resolved')) d.notify_resolved = checked('nt-r-resolved');
      if (document.getElementById('nt-r-repeat')) d.repeat_s = Math.round((Number(val('nt-r-repeat')) || 0) * 60);
    } else if (d.kind === 'schedule') {
      d.report = val('nt-r-report') || d.report;
      if (document.getElementById('nt-r-day')) d.day = val('nt-r-day');
      d.time = val('nt-r-time');
      var wds = checkedValues('nt-r-wd').map(Number);
      d.days = wds.length === 7 ? [] : wds;
      if (document.getElementById('nt-r-below')) d.below_kwh = val('nt-r-below');
    } else {
      d.event = val('nt-r-event');
      d.subject = val('nt-r-subject').trim();
    }
    return d;
  }

  function historyCard() {
    var rows = log.length ? '<div class="nt-table-wrap"><table class="st-table nt-table"><thead><tr><th>When</th><th>Alert</th><th>Channel</th><th>Result</th></tr></thead><tbody>' + log.map(function (l) {
      var res = l.status === 'sent' ? pill('Sent', 'ok') : l.status === 'quiet' ? pill('Quiet hours', 'off') : pill('Failed', 'error');
      return '<tr><td class="nt-nowrap">' + esc(fmtTime(l.timestamp)) + '</td><td><strong>' + esc(l.title || l.rule_name || '') + '</strong>' + (l.body ? '<div class="nt-muted">' + esc(l.body) + '</div>' : '') + '</td>' +
        '<td>' + esc(l.channel_name || '—') + '</td><td>' + res + (l.error ? '<div class="nt-muted">' + esc(l.error) + '</div>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="st-help">Nothing sent yet.</p>';
    return '<div class="st-card" id="nt-history"><div class="st-card-head"><h2>History</h2><div class="st-inline-actions"><button type="button" class="st-btn" data-act="log-refresh">Refresh</button>' +
      (log.length ? '<button type="button" class="st-btn st-btn-danger-text" data-act="log-clear">Clear</button>' : '') + '</div></div>' + rows + '</div>';
  }

  function render() {
    if (!state) return;
    var focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
    root.innerHTML = generalCard() + devicesCard() + channelsCard() + rulesCard() + historyCard();
    if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  }

  function scrollToEditor(id) {
    var el = document.getElementById(id);
    if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); var f = el.querySelector('input,select'); if (f) f.focus({ preventScroll: true }); }
  }

  async function confirmDelete(title, body) {
    if (!shell.openDialog) return window.confirm(title);
    var r = await shell.openDialog({ title: title, body: '<p>' + esc(body) + '</p>', actions: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'delete', kind: 'danger' }] });
    return !!r && r.value === 'delete';
  }

  async function askName(title, current) {
    if (!shell.openDialog) return window.prompt(title, current);
    var r = await shell.openDialog({
      title: title,
      body: '<div class="st-field"><label for="nt-dlg-name">Name</label><input id="nt-dlg-name" class="input" required maxlength="60" value="' + esc(current) + '"></div>',
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', kind: 'primary' }]
    });
    return r && r.value === 'save' ? r.form.querySelector('#nt-dlg-name').value : null;
  }

  function plusIcon() { return shell.icon ? shell.icon('plus', 16) : ''; }

  var CHANNEL_CHOICES = [
    ['webpush', 'Push to devices', 'Notifications on the phones, tablets and computers where you turn push on.'],
    ['telegram', 'Telegram', 'Messages from your own bot. It can also answer /status.'],
    ['discord', 'Discord', 'Posts to a Discord channel through a webhook.'],
    ['ntfy', 'ntfy', 'ntfy.sh or your own ntfy server, with its phone app.'],
    ['webhook', 'Webhook', 'JSON to Home Assistant, n8n, Node-RED or your own script.']
  ];
  var RULE_CHOICES = [
    ['Common alerts', [
      ['grid-off', 'Grid outage', 'When the grid goes off. Critical, so it gets through quiet hours.'],
      ['grid-on', 'Grid restored', 'When the grid comes back, with how long it was off.'],
      ['battery-low', 'Battery low', 'When the battery charge stays under 20% for 5 minutes.'],
      ['source-offline', 'Source offline', 'When a source stops answering, and when it is back.'],
      ['stale', 'Data stopped updating', 'When a metric has had no new value for 15 minutes.'],
      ['forecast-down', 'Forecast unavailable', 'When Solcast or Open-Meteo cannot be reached.']
    ]],
    ['Reports', [
      ['summary', 'Evening summary', "Today's solar, usage, grid and savings at 21:00."],
      ['low-solar', 'Low solar tomorrow', 'A warning in the evening when tomorrow looks poor.']
    ]],
    ['Build your own', [
      ['metric', 'Metric rule', 'Any metric above, below, equal to a value, changing or not updating.'],
      ['event', 'Event rule', 'Any event, or a whole group of them.'],
      ['schedule', 'Scheduled report', 'A summary, forecast or status at a set time.']
    ]]
  ];

  /** Picker dialog in the add-source style. Resolves the chosen value or null. */
  async function pick(title, groups, name) {
    var html = '<fieldset class="st-choices"><legend class="st-visually-hidden">' + esc(title) + '</legend>';
    groups.forEach(function (g, gi) {
      if (g[0]) html += '<p class="st-choice-group">' + esc(g[0]) + '</p>';
      g[1].forEach(function (c, i) {
        html += '<label class="st-choice"><input type="radio" name="' + name + '" value="' + esc(c[0]) + '" required' + (gi === 0 && i === 0 ? ' checked' : '') + '>' +
          '<span><span class="st-choice-title">' + esc(c[1]) + '</span><span class="st-choice-desc">' + esc(c[2]) + '</span></span></label>';
      });
    });
    var r = await shell.openDialog({ title: title, body: html + '</fieldset>', actions: [{ label: 'Cancel', value: null }, { label: 'Continue', value: 'ok', kind: 'primary' }] });
    return r && r.value === 'ok' ? r.form.elements[name].value : null;
  }

  function startChannel(type) {
    editChannel = { id: null, type: type, draft: { name: TYPE_LABEL[type], enabled: true, config: type === 'webpush' ? { devices: 'all' } : {} } };
    render(); scrollToEditor('nt-channel-editor');
  }
  function startRule(preset) {
    var draft = PRESETS[preset]();
    draft.enabled = true;
    draft.channels = defaultChannels();
    editRule = { id: null, draft: draft };
    render(); scrollToEditor('nt-rule-editor');
  }

  var generalTimer = null;
  /** Save the General card (each control saves on change). */
  async function saveGeneral() {
    var body = { enabled: checked('nt-enabled'), quiet_hours: { enabled: checked('nt-quiet') }, base_url: val('nt-base-url').trim() };
    if (document.getElementById('nt-quiet-start')) { body.quiet_hours.start = val('nt-quiet-start'); body.quiet_hours.end = val('nt-quiet-end'); }
    var quietChanged = !!state.settings.quiet_hours.enabled !== body.quiet_hours.enabled;
    state.settings = await api('PUT', '/settings', body);
    toast('Saved.');
    if (quietChanged) render(); // show or hide the quiet hours times
  }

  // ── Actions ──────────────────────────────────────────────────────────
  async function onAction(act, el) {
    var id = el.dataset.id;
    switch (act) {
      case 'reload': return load();
      case 'push-on': return enablePush();
      case 'push-off': return disablePush(id);
      case 'device-test': await api('POST', '/devices/' + encodeURIComponent(id) + '/test'); toast('Test sent. It should arrive in a few seconds.'); return refreshLog();
      case 'device-remove': {
        var dev = state.devices.find(function (d) { return d.id === id; });
        if (!await confirmDelete('Remove ' + (dev ? dev.label : 'device') + '?', 'It stops getting push notifications. You can turn push on again from that device.')) return;
        if (currentDevice() && currentDevice().id === id) return disablePush(id);
        await api('DELETE', '/devices/' + encodeURIComponent(id));
        return load();
      }
      case 'device-rename': {
        var dv = state.devices.find(function (d) { return d.id === id; });
        var name = await askName('Rename device', dv ? dv.label : '');
        if (!name || !name.trim()) return;
        await api('PATCH', '/devices/' + encodeURIComponent(id), { label: name.trim() });
        return load();
      }
      case 'channel-pick': {
        var type = await pick('Add a channel', [['', CHANNEL_CHOICES]], 'ntChannelType');
        if (type) startChannel(type);
        return;
      }
      case 'channel-edit': {
        var ch = state.channels.find(function (c) { return c.id === id; });
        editChannel = { id: id, type: ch.type, draft: JSON.parse(JSON.stringify(ch)) };
        render(); return scrollToEditor('nt-channel-editor');
      }
      case 'channel-cancel': editChannel = null; return render();
      case 'channel-save': {
        var body = readChannelForm();
        var saved = editChannel.id ? await api('PUT', '/channels/' + encodeURIComponent(editChannel.id), body) : await api('POST', '/channels', body);
        editChannel = null;
        // Telegram checks the chat on save: say what it changed or found.
        if (saved.warning) toast('Saved, but: ' + saved.warning, 'error');
        else toast(saved.note ? 'Channel saved. ' + saved.note : 'Channel saved.');
        return load();
      }
      case 'channel-test': {
        var out = await api('POST', '/channels/test', readChannelForm());
        if (out.chat_id && document.getElementById('nt-ch-chat')) document.getElementById('nt-ch-chat').value = out.chat_id;
        if (out.note) { toast('Test sent. ' + out.note + ' Save to keep it.'); return refreshLog(); }
        toast(out.warning ? 'Sent, with problems: ' + out.warning : 'Test sent. Check ' + (TYPE_LABEL[editChannel.type] || 'the channel') + '.');
        return refreshLog();
      }
      case 'channel-test-saved': {
        var c2 = state.channels.find(function (c) { return c.id === id; });
        var out2 = await api('POST', '/channels/test', { id: c2.id, type: c2.type, name: c2.name, enabled: true, config: c2.config });
        if (out2.note) { toast('Test sent to ' + c2.name + '. ' + out2.note); return load(); }
        toast(out2.warning ? 'Sent, with problems: ' + out2.warning : 'Test sent to ' + c2.name + '.');
        return refreshLog();
      }
      case 'channel-delete': {
        var c3 = state.channels.find(function (c) { return c.id === id; });
        if (!await confirmDelete('Delete ' + c3.name + '?', 'Rules stop sending to it.')) return;
        await api('DELETE', '/channels/' + encodeURIComponent(id));
        return load();
      }
      case 'telegram-find': {
        var box = document.getElementById('nt-chats');
        box.innerHTML = '<p class="st-help">Looking for chats…</p>';
        try {
          var found = await api('POST', '/telegram/chats', { bot_token: val('nt-ch-bot').trim(), id: editChannel.id || undefined });
          var chatInput = document.getElementById('nt-ch-chat');
          var current = chatInput.value.trim();
          if (!found.chats.length) {
            box.innerHTML = '<p class="st-help nt-warn">No chats found. Send your bot a message in Telegram first, then try again.</p>';
          } else if (found.chats.length === 1 && current !== found.chats[0].id) {
            // One chat: fill it in, and say so if it replaced a different ID.
            chatInput.value = found.chats[0].id;
            box.innerHTML = '<p class="st-help">' + (current ? 'Replaced ' + esc(current) + ' with ' : 'Filled in ') + 'the chat with ' + esc(found.chats[0].name) + ' (' + esc(found.chats[0].id) + '). Save to keep it.</p>';
          } else {
            var matches = found.chats.some(function (c) { return c.id === current; });
            box.innerHTML = (current && !matches ? '<p class="st-help nt-warn">The Chat ID above is not one of the chats that messaged this bot. Pick one:</p>' : '') +
              '<div class="st-inline-actions">' + found.chats.map(function (c) {
                return '<button type="button" class="st-btn" data-act="telegram-pick" data-chat="' + esc(c.id) + '">' + esc(c.name) + ' <span class="nt-muted">' + esc(c.type) + ' · ' + esc(c.id) + '</span></button>';
              }).join('') + '</div>';
          }
        } catch (e) { box.innerHTML = '<p class="st-help nt-warn">' + esc(e.message) + '</p>'; }
        return;
      }
      case 'telegram-pick': document.getElementById('nt-ch-chat').value = el.dataset.chat; document.getElementById('nt-chats').innerHTML = ''; return;
      case 'rule-pick': {
        var preset = await pick('Add a rule', RULE_CHOICES, 'ntRulePreset');
        if (preset) startRule(preset);
        return;
      }
      case 'rule-edit': editRule = { id: id, draft: JSON.parse(JSON.stringify(state.rules.find(function (r) { return r.id === id; }))) }; render(); return scrollToEditor('nt-rule-editor');
      case 'rule-cancel': editRule = null; return render();
      case 'rule-kind': {
        syncRuleDraft();
        var k = el.dataset.kind;
        if (editRule.draft.kind !== k) {
          var keep = { name: editRule.draft.name, channels: editRule.draft.channels, enabled: editRule.draft.enabled };
          editRule.draft = Object.assign(PRESETS[k](), keep);
        }
        return render();
      }
      case 'rule-save': {
        var rd = syncRuleDraft();
        if (rd.kind === 'schedule' && !checkedValues('nt-r-wd').length) throw new Error('Pick at least one day.');
        if (editRule.id) await api('PUT', '/rules/' + encodeURIComponent(editRule.id), rd);
        else await api('POST', '/rules', rd);
        editRule = null;
        toast('Rule saved.');
        return load();
      }
      case 'rule-test': {
        var r = await api('POST', '/rules/' + encodeURIComponent(id) + '/test');
        var bad = (r.results || []).filter(function (x) { return !x.ok && !x.skipped; });
        if (!bad.length && r.skipped) { toast('Sent. (On schedule it would be skipped today: ' + r.skipped + '.)'); return refreshLog(); }
        toast(bad.length ? 'Some channels failed: ' + bad.map(function (x) { return (x.name || x.id) + ' (' + x.error + ')'; }).join(', ') : 'Test sent to this rule\'s channels.', bad.length ? 'error' : null);
        return refreshLog();
      }
      case 'rule-delete': {
        var rr = state.rules.find(function (r) { return r.id === id; });
        if (!await confirmDelete('Delete rule ' + rr.name + '?', 'It stops sending alerts.')) return;
        await api('DELETE', '/rules/' + encodeURIComponent(id));
        return load();
      }
      case 'log-refresh': return refreshLog();
      case 'log-clear': await api('DELETE', '/log'); log = []; return refreshLog();
    }
  }

  function run(act, el) {
    var busy = el.tagName === 'BUTTON';
    if (busy) el.disabled = true;
    Promise.resolve(onAction(act, el)).catch(function (e) {
      toast(e.message || String(e), 'error');
      if (/test/.test(act)) refreshLog(); // failed tests are logged too
    }).then(function () { if (busy && document.contains(el)) el.disabled = false; });
  }

  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    e.preventDefault();
    run(el.dataset.act, el);
  });

  root.addEventListener('change', function (e) {
    var el = e.target;
    if (el.dataset.act === 'rule-toggle' || el.dataset.act === 'channel-toggle') {
      var isRule = el.dataset.act === 'rule-toggle';
      var item = (isRule ? state.rules : state.channels).find(function (x) { return x.id === el.dataset.id; });
      if (!item) return;
      api('PATCH', (isRule ? '/rules/' : '/channels/') + encodeURIComponent(item.id), { enabled: el.checked })
        .then(function (saved) { item.enabled = saved.enabled; toast((isRule ? 'Rule ' : 'Channel ') + (saved.enabled ? 'on.' : 'off.')); })
        .catch(function (err) { el.checked = !el.checked; toast(err.message, 'error'); });
    } else if (el.hasAttribute('data-general')) {
      clearTimeout(generalTimer);
      generalTimer = setTimeout(function () {
        saveGeneral().catch(function (err) { toast(err.message, 'error'); });
      }, el.type === 'checkbox' ? 0 : 300);
    } else if (el.dataset.act === 'webpush-all') {
      editChannel.draft = Object.assign(editChannel.draft, readChannelForm());
      render();
    } else if (el.dataset.act === 'rule-op') {
      syncRuleDraft(); render();
    } else if (el.id === 'nt-r-event') {
      syncRuleDraft(); render();
    } else if (el.id === 'nt-r-report') {
      syncRuleDraft();
      var rp = (state.reports || []).find(function (x) { return x.id === editRule.draft.report; });
      if (rp && rp.days.indexOf(editRule.draft.day) < 0) editRule.draft.day = rp.days[0] || '';
      render();
    }
  });

  root.addEventListener('input', function (e) {
    if (e.target.id !== 'nt-r-metric') return;
    var info = metricInfo(e.target.value.trim());
    var hint = document.getElementById('nt-r-metric-now');
    if (hint) hint.textContent = info ? (info.value != null ? 'Now: ' + info.value + (info.unit ? ' ' + info.unit : '') : 'No current value') : '';
  });

  // Enter in a field must not submit anything else on the page; arrows move
  // within the Watch control like the theme picker.
  root.addEventListener('keydown', function (e) {
    var seg = e.target.closest && e.target.closest('.nt-seg');
    if (seg && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      var opts = Array.prototype.slice.call(seg.querySelectorAll('[role="radio"]'));
      var i = opts.indexOf(e.target);
      var next = opts[(i + (e.key === 'ArrowRight' ? 1 : opts.length - 1)) % opts.length];
      e.preventDefault();
      run('rule-kind', next);
      setTimeout(function () { var b = root.querySelector('.nt-seg [aria-checked="true"]'); if (b) b.focus(); }, 0);
      return;
    }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') e.preventDefault();
  });

  document.addEventListener('st:section-shown', function (e) {
    if (e.detail && e.detail.section === 'notifications') { if (!loaded) load(); else refreshLog(); }
  });
  if (!document.getElementById('section-notifications').hidden) load();
})();
