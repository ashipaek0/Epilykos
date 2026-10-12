/**
 * Settings → Notifications. Self-contained: talks to /api/notifications and
 * saves each change on its own (the section sits outside the settings form
 * and the save bar). Loaded after settings-shell.js (window.stShell).
 *
 *   General   on/off, quiet hours, dashboard address for links
 *   Devices   web push on this browser + every subscribed device
 *   Channels  Telegram, Discord, ntfy, push (to all or chosen devices)
 *   Rules     any metric (threshold, equals, changes, stale) or any event
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

  var TYPE_LABEL = { telegram: 'Telegram', discord: 'Discord', ntfy: 'ntfy', webpush: 'Push to devices' };
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
  function sevPill(sev) { return '<span class="nt-sev nt-sev-' + esc(sev || 'info') + '">' + esc(SEVERITY_LABEL[sev] || 'From event') + '</span>'; }
  function toggle(id, checked, label, extra) {
    return '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + (extra || '') + '><span class="slider"></span></label><label for="' + id + '">' + esc(label) + '</label></span>';
  }
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
    if (r.kind === 'event') {
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
    if (c.type === 'telegram') return 'Chat ' + esc(cfg.chat_id || '?');
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
      '<div class="st-toggle-row">' + toggle('nt-enabled', s.enabled, 'Send notifications') + '</div>' +
      '<div class="st-toggle-row">' + toggle('nt-quiet', q.enabled, 'Quiet hours') + '</div>' +
      '<div class="st-grid-2">' +
        field('nt-quiet-start', 'Quiet from', input('nt-quiet-start', q.start, ' type="time"')) +
        field('nt-quiet-end', 'Until', input('nt-quiet-end', q.end, ' type="time"')) +
      '</div>' +
      '<p class="st-help nt-gap">During quiet hours only critical alerts are sent; the rest are noted in History.</p>' +
      field('nt-base-url', 'Dashboard address for links', input('nt-base-url', s.base_url, ' type="url" placeholder="https://energy.example.com"'), 'Telegram, Discord and ntfy messages link here. Leave empty for no link.') +
      '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" data-act="save-general">Save</button></div></div>';
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
        '<div class="st-inline-actions"><button type="button" class="st-btn" data-act="device-test" data-id="' + esc(cur.id) + '">Send test</button><button type="button" class="st-btn st-btn-danger-text" data-act="push-off" data-id="' + esc(cur.id) + '">Turn off on this device</button></div>';
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
        (c.enabled ? pill('On', 'ok') : pill('Off', 'off')) +
        '<div class="nt-item-actions"><button type="button" class="st-btn" data-act="channel-edit" data-id="' + esc(c.id) + '">Edit</button>' +
        '<button type="button" class="st-btn" data-act="channel-test-saved" data-id="' + esc(c.id) + '">Test</button>' +
        '<button type="button" class="st-btn st-btn-danger-text" data-act="channel-delete" data-id="' + esc(c.id) + '">Delete</button></div></li>';
    }).join('');
    var adding = editChannel && !editChannel.id ? '<div class="nt-editor-wrap">' + channelEditor() + '</div>' : '';
    return '<div class="st-card"><div class="st-card-head"><h2>Channels</h2></div>' +
      '<p class="st-help">Where alerts go. Each rule picks one or more channels.</p>' +
      (items ? '<ul class="nt-list">' + items + '</ul>' : '<p class="st-help">No channels yet.</p>') + adding +
      '<div class="st-inline-actions"><span class="nt-add-label">Add:</span>' +
        ['telegram', 'discord', 'ntfy', 'webpush'].map(function (t) { return '<button type="button" class="st-btn" data-act="channel-new" data-type="' + t + '">' + esc(TYPE_LABEL[t]) + '</button>'; }).join('') +
      '</div></div>';
  }

  function channelEditor() {
    var d = editChannel.draft, cfg = d.config || {}, t = editChannel.type, html = '';
    var secretHint = function (has) { return has ? ' placeholder="Saved — leave empty to keep"' : ''; };
    html += field('nt-ch-name', 'Name', input('nt-ch-name', d.name, ' maxlength="60"'));
    if (t === 'telegram') {
      html += field('nt-ch-bot', 'Bot token', input('nt-ch-bot', cfg.bot_token, ' type="password" autocomplete="off"' + secretHint(cfg.has_bot_token)),
        'Message <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> on Telegram, send /newbot and paste the token here.');
      html += '<div class="nt-row-form">' + field('nt-ch-chat', 'Chat ID', input('nt-ch-chat', cfg.chat_id, ' inputmode="numeric" placeholder="123456789"'),
        'Send your bot any message (or add it to a group), then press Find chat.') +
        '<button type="button" class="st-btn" data-act="telegram-find">Find chat</button></div><div id="nt-chats"></div>';
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
    } else if (t === 'webpush') {
      var all = cfg.devices === 'all';
      html += '<fieldset class="nt-fieldset"><legend>Send to</legend>' +
        '<label class="nt-check"><input type="radio" name="nt-ch-devmode" value="all"' + (all ? ' checked' : '') + '> All devices, including ones added later</label>' +
        '<label class="nt-check"><input type="radio" name="nt-ch-devmode" value="some"' + (!all ? ' checked' : '') + '> Only these devices:</label>' +
        '<div class="nt-checks nt-indent">' + (state.devices.length ? state.devices.map(function (dv) {
          var on = Array.isArray(cfg.devices) && cfg.devices.indexOf(dv.id) >= 0;
          return '<label class="nt-check"><input type="checkbox" name="nt-ch-dev" value="' + esc(dv.id) + '"' + (on ? ' checked' : '') + '> ' + esc(dv.label) + '</label>';
        }).join('') : '<span class="st-help">No devices yet — turn on push on a device above.</span>') + '</div></fieldset>';
    }
    html += '<div class="st-toggle-row">' + toggle('nt-ch-enabled', d.enabled !== false, 'Channel on') + '</div>';
    html += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" data-act="channel-save">Save channel</button>' +
      '<button type="button" class="st-btn" data-act="channel-test">Send test</button>' +
      '<button type="button" class="st-btn" data-act="channel-cancel">Cancel</button></div>';
    return '<div class="nt-editor" id="nt-channel-editor"><h3 class="nt-editor-title">' + esc((editChannel.id ? 'Edit ' : 'New ') + TYPE_LABEL[t] + ' channel') + '</h3>' + html + '</div>';
  }

  function readChannelForm() {
    var t = editChannel.type, cfg = {};
    if (t === 'telegram') { cfg.bot_token = val('nt-ch-bot').trim(); cfg.chat_id = val('nt-ch-chat').trim(); }
    if (t === 'discord') { cfg.webhook_url = val('nt-ch-webhook').trim(); cfg.mention_here = checked('nt-ch-here'); }
    if (t === 'ntfy') { cfg.server_url = val('nt-ch-server').trim(); cfg.topic = val('nt-ch-topic').trim() || (document.getElementById('nt-ch-topic') || {}).placeholder || ''; cfg.token = val('nt-ch-token').trim(); cfg.allow_private = checked('nt-ch-private'); }
    if (t === 'webpush') {
      var mode = root.querySelector('input[name="nt-ch-devmode"]:checked');
      cfg.devices = mode && mode.value === 'all' ? 'all' : Array.prototype.map.call(root.querySelectorAll('input[name="nt-ch-dev"]:checked'), function (x) { return x.value; });
    }
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
    'metric': function () { return { kind: 'metric', name: '', metric: '', operator: 'gt', value: '', for_s: 0, severity: 'warning', cooldown_s: 900 }; },
    'event': function () { return { kind: 'event', name: '', event: '', severity: '', cooldown_s: 0 }; }
  };

  function rulesCard() {
    var items = state.rules.map(function (r) {
      if (editRule && editRule.id === r.id) return '<li class="nt-item nt-item-editing">' + ruleEditor() + '</li>';
      return '<li class="nt-item"><div class="nt-item-text"><span class="nt-item-name">' + esc(r.name) + ' ' + sevPill(r.severity) + '</span><span class="nt-item-sub">' + ruleSummary(r) + '</span></div>' +
        '<span class="toggle-wrap"><label class="toggle-switch" title="Rule on/off"><input type="checkbox" data-act="rule-toggle" data-id="' + esc(r.id) + '"' + (r.enabled ? ' checked' : '') + ' aria-label="' + esc(r.name) + ' on"><span class="slider"></span></label></span>' +
        '<div class="nt-item-actions"><button type="button" class="st-btn" data-act="rule-edit" data-id="' + esc(r.id) + '">Edit</button>' +
        '<button type="button" class="st-btn" data-act="rule-test" data-id="' + esc(r.id) + '">Test</button>' +
        '<button type="button" class="st-btn st-btn-danger-text" data-act="rule-delete" data-id="' + esc(r.id) + '">Delete</button></div></li>';
    }).join('');
    var adding = editRule && !editRule.id ? '<div class="nt-editor-wrap">' + ruleEditor() + '</div>' : '';
    var presets = [['grid-off', 'Grid outage'], ['grid-on', 'Grid restored'], ['battery-low', 'Battery low'], ['source-offline', 'Source offline'], ['stale', 'Data stopped updating'], ['metric', 'Custom metric rule'], ['event', 'Custom event rule']];
    return '<div class="st-card"><div class="st-card-head"><h2>Alert rules</h2></div>' +
      '<p class="st-help">A rule watches any metric or any event and sends to the channels you pick.</p>' +
      (items ? '<ul class="nt-list">' + items + '</ul>' : '<p class="st-help">No rules yet. Start from one of these:</p>') + adding +
      '<div class="st-inline-actions"><span class="nt-add-label">Add:</span>' + presets.map(function (p) {
        return '<button type="button" class="st-btn" data-act="rule-new" data-preset="' + p[0] + '">' + esc(p[1]) + '</button>';
      }).join('') + '</div></div>';
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
    html += '<div class="st-field"><span class="nt-label">Watch</span><div class="st-seg nt-seg" role="radiogroup">' +
      '<button type="button" role="radio" data-act="rule-kind" data-kind="metric" aria-checked="' + (kind === 'metric') + '">A metric</button>' +
      '<button type="button" role="radio" data-act="rule-kind" data-kind="event" aria-checked="' + (kind === 'event') + '">An event</button></div></div>';
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
    } else {
      html += field('nt-r-event', 'Event', '<select id="nt-r-event" class="input">' + eventOptions(d.event) + '</select>', (function () {
        var t = state.eventTypes.find(function (e) { return e.type === d.event; }); return t ? esc(t.description) : '';
      })());
      html += field('nt-r-subject', 'Only for (optional)', input('nt-r-subject', d.subject, ' placeholder="e.g. modbus, or a broker address"'), 'Limit to one source or broker. Leave empty for all.');
    }
    html += '<div class="st-grid-2">' +
      field('nt-r-sev', 'Severity', '<select id="nt-r-sev" class="input">' + (kind === 'event' ? '<option value="">Use the event\'s own</option>' : '') +
        ['info', 'warning', 'critical'].map(function (s) { return '<option value="' + s + '"' + (d.severity === s ? ' selected' : '') + '>' + SEVERITY_LABEL[s] + '</option>'; }).join('') + '</select>',
        'Critical alerts are sent during quiet hours too.') +
      field('nt-r-cool', 'Wait before alerting again (minutes)', input('nt-r-cool', d.cooldown_s ? d.cooldown_s / 60 : 0, ' type="number" min="0" step="1"')) +
      '</div>';
    var chosen = d.channels || [];
    html += '<fieldset class="nt-fieldset"><legend>Send to</legend><div class="nt-checks">' + (state.channels.length ? state.channels.map(function (c) {
      return '<label class="nt-check"><input type="checkbox" name="nt-r-ch" value="' + esc(c.id) + '"' + (chosen.indexOf(c.id) >= 0 ? ' checked' : '') + '> ' + esc(c.name) + ' <span class="nt-muted">' + esc(TYPE_LABEL[c.type]) + (c.enabled ? '' : ', off') + '</span></label>';
    }).join('') : '<span class="st-help nt-warn">Add a channel first (below Push devices).</span>') + '</div></fieldset>';
    html += field('nt-r-msg', 'Custom message (optional)', input('nt-r-msg', d.message, ' maxlength="500"'),
      kind === 'metric' ? 'Use {metric}, {value}, {threshold}, {previous} and {rule}.' : 'Use {message}, {subject}, {event} and {rule}.');
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
    d.channels = Array.prototype.map.call(root.querySelectorAll('input[name="nt-r-ch"]:checked'), function (x) { return x.value; });
    if (d.kind === 'metric') {
      d.metric = val('nt-r-metric').trim();
      d.operator = val('nt-r-op') || d.operator;
      if (document.getElementById('nt-r-value')) d.value = val('nt-r-value');
      if (document.getElementById('nt-r-for')) d.for_s = Math.round((Number(val('nt-r-for')) || 0) * 60);
      if (document.getElementById('nt-r-hyst')) d.hysteresis = val('nt-r-hyst');
      if (document.getElementById('nt-r-resolved')) d.notify_resolved = checked('nt-r-resolved');
      if (document.getElementById('nt-r-repeat')) d.repeat_s = Math.round((Number(val('nt-r-repeat')) || 0) * 60);
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

  // ── Actions ──────────────────────────────────────────────────────────
  async function onAction(act, el) {
    var id = el.dataset.id;
    switch (act) {
      case 'reload': return load();
      case 'save-general': {
        state.settings = await api('PUT', '/settings', {
          enabled: checked('nt-enabled'),
          quiet_hours: { enabled: checked('nt-quiet'), start: val('nt-quiet-start'), end: val('nt-quiet-end') },
          base_url: val('nt-base-url').trim()
        });
        return toast('Notification settings saved.');
      }
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
      case 'channel-new':
        editChannel = { id: null, type: el.dataset.type, draft: { name: TYPE_LABEL[el.dataset.type], enabled: true, config: el.dataset.type === 'webpush' ? { devices: 'all' } : {} } };
        render(); return scrollToEditor('nt-channel-editor');
      case 'channel-edit': {
        var ch = state.channels.find(function (c) { return c.id === id; });
        editChannel = { id: id, type: ch.type, draft: JSON.parse(JSON.stringify(ch)) };
        render(); return scrollToEditor('nt-channel-editor');
      }
      case 'channel-cancel': editChannel = null; return render();
      case 'channel-save': {
        var body = readChannelForm();
        if (editChannel.id) await api('PUT', '/channels/' + encodeURIComponent(editChannel.id), body);
        else await api('POST', '/channels', body);
        editChannel = null;
        toast('Channel saved.');
        return load();
      }
      case 'channel-test': {
        var out = await api('POST', '/channels/test', readChannelForm());
        toast(out.warning ? 'Sent, with problems: ' + out.warning : 'Test sent. Check ' + (TYPE_LABEL[editChannel.type] || 'the channel') + '.');
        return refreshLog();
      }
      case 'channel-test-saved': {
        var c2 = state.channels.find(function (c) { return c.id === id; });
        var out2 = await api('POST', '/channels/test', { id: c2.id, type: c2.type, name: c2.name, enabled: true, config: c2.config });
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
          box.innerHTML = found.chats.length ? '<div class="st-inline-actions">' + found.chats.map(function (c) {
            return '<button type="button" class="st-btn" data-act="telegram-pick" data-chat="' + esc(c.id) + '">' + esc(c.name) + ' <span class="nt-muted">' + esc(c.type) + '</span></button>';
          }).join('') + '</div>' : '<p class="st-help nt-warn">No chats found. Send your bot a message in Telegram first, then try again.</p>';
        } catch (e) { box.innerHTML = '<p class="st-help nt-warn">' + esc(e.message) + '</p>'; }
        return;
      }
      case 'telegram-pick': document.getElementById('nt-ch-chat').value = el.dataset.chat; document.getElementById('nt-chats').innerHTML = ''; return;
      case 'rule-new': {
        var draft = PRESETS[el.dataset.preset]();
        draft.enabled = true;
        draft.channels = defaultChannels();
        editRule = { id: null, draft: draft };
        render(); return scrollToEditor('nt-rule-editor');
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
        if (editRule.id) await api('PUT', '/rules/' + encodeURIComponent(editRule.id), rd);
        else await api('POST', '/rules', rd);
        editRule = null;
        toast('Rule saved.');
        return load();
      }
      case 'rule-test': {
        var r = await api('POST', '/rules/' + encodeURIComponent(id) + '/test');
        var bad = (r.results || []).filter(function (x) { return !x.ok && !x.skipped; });
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
    if (el.dataset.act === 'rule-toggle') {
      var r = state.rules.find(function (x) { return x.id === el.dataset.id; });
      if (!r) return;
      api('PUT', '/rules/' + encodeURIComponent(r.id), Object.assign({}, r, { enabled: el.checked }))
        .then(function (saved) { Object.assign(r, saved); toast(saved.enabled ? 'Rule on.' : 'Rule off.'); })
        .catch(function (err) { el.checked = !el.checked; toast(err.message, 'error'); });
    } else if (el.dataset.act === 'rule-op') {
      syncRuleDraft(); render();
    } else if (el.id === 'nt-r-event') {
      syncRuleDraft(); render();
    }
  });

  root.addEventListener('input', function (e) {
    if (e.target.id !== 'nt-r-metric') return;
    var info = metricInfo(e.target.value.trim());
    var hint = document.getElementById('nt-r-metric-now');
    if (hint) hint.textContent = info ? (info.value != null ? 'Now: ' + info.value + (info.unit ? ' ' + info.unit : '') : 'No current value') : '';
  });

  // Enter in a field must not submit anything else on the page.
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') e.preventDefault();
  });

  document.addEventListener('st:section-shown', function (e) {
    if (e.detail && e.detail.section === 'notifications') { if (!loaded) load(); else refreshLog(); }
  });
  if (!document.getElementById('section-notifications').hidden) load();
})();
