/**
 * Settings → Home Assistant: publish Epilykos metrics to an MQTT broker as Home Assistant sensors.
 * Talks to /api/ha-discovery and saves nothing through the save bar (the card has data-own-save).
 * Loaded after settings-shell.js. Everything is drawn with textContent.
 */
(function () {
  'use strict';

  var root = document.getElementById('had-root');
  if (!root) return;
  var shell = window.stShell || {};
  var data = null;

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }

  function api(path, body) {
    var opts = { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/ha-discovery' + path, opts).then(function (res) {
      if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
        return d;
      });
    });
  }

  function field(id, label, attrs, help) {
    var wrap = el('div', { class: 'st-field' });
    wrap.appendChild(el('label', { for: id }, label));
    wrap.appendChild(el('input', Object.assign({ id: id, class: 'input', autocomplete: 'off' }, attrs || {})));
    if (help) wrap.appendChild(el('p', { class: 'st-help' }, help));
    return wrap;
  }

  function statusText(st) {
    if (!st || st.state === 'off') return '';
    if (st.state === 'connected') return 'Connected. ' + st.sensors + (st.sensors === 1 ? ' sensor' : ' sensors') + ' published.';
    if (st.state === 'connecting') return 'Connecting…' + (st.error ? ' ' + st.error : '');
    return st.error || 'Not connected.';
  }

  /** The status line and badge only, so a poll never redraws the form while someone is typing. */
  function updateStatus() {
    var s = data.settings, st = data.status;
    var line = document.getElementById('had-status');
    if (line) line.textContent = statusText(st);
    var badge = document.getElementById('had-badge');
    if (badge) {
      badge.hidden = !s.enabled;
      badge.className = 'st-badge ' + (st.state === 'connected' ? 'is-ok' : st.state === 'error' ? 'is-error' : 'is-warn');
      badge.textContent = st.state === 'connected' ? 'Connected' : st.state === 'error' ? 'Not connected' : 'Connecting';
    }
  }

  function draw() {
    var s = data.settings, st = data.status;
    root.textContent = '';

    var toggle = el('div', { class: 'st-toggle-row' });
    var tw = el('span', { class: 'toggle-wrap' });
    var tl = el('label', { class: 'toggle-switch' });
    var cb = el('input', { type: 'checkbox', id: 'had-enabled' });
    cb.checked = !!s.enabled;
    tl.appendChild(cb); tl.appendChild(el('span', { class: 'slider' }));
    tw.appendChild(tl); tw.appendChild(el('label', { for: 'had-enabled' }, 'Publish to Home Assistant'));
    toggle.appendChild(tw);
    root.appendChild(toggle);

    root.appendChild(field('had-broker', 'MQTT broker address', { type: 'text', value: s.broker || '', placeholder: 'mqtt://192.168.0.10:1883' },
      'The broker Home Assistant is connected to (often the Mosquitto add-on). Use mqtt://, mqtts://, ws:// or wss://.'));
    var two = el('div', { class: 'st-grid-2' });
    two.appendChild(field('had-user', 'Username', { type: 'text', value: s.username || '' }));
    var pw = field('had-pass', 'Password', { type: 'password', placeholder: s.hasPassword ? 'Saved. Leave empty to keep it.' : '', autocomplete: 'new-password' });
    two.appendChild(pw);
    root.appendChild(two);
    root.appendChild(field('had-prefix', 'Discovery prefix', { type: 'text', value: s.prefix || 'homeassistant' }, 'Leave as homeassistant unless you changed it in Home Assistant.'));

    var fs = el('fieldset', { class: 'st-field' });
    fs.appendChild(el('legend', {}, 'Which metrics'));
    [['roles', 'Only the metrics chosen as roles', 'Solar, load, battery, grid and the like. A tidy start.'], ['all', 'Every metric', 'Everything Epilykos reads. Can be hundreds of sensors.']].forEach(function (o) {
      var l = el('label', { class: 'st-radio' });
      var r = el('input', { type: 'radio', name: 'had-mode', value: o[0] });
      r.checked = (s.mode || 'roles') === o[0];
      l.appendChild(r); l.appendChild(el('span', {}, ' ' + o[1] + ' '));
      l.appendChild(el('span', { class: 'st-help' }, o[2]));
      fs.appendChild(l);
    });
    root.appendChild(fs);

    var line = el('p', { class: 'st-help', role: 'status', id: 'had-status' }, statusText(st));
    root.appendChild(line);

    var actions = el('div', { class: 'st-health-actions' });
    var save = el('button', { type: 'button', class: 'st-btn st-btn-primary' }, 'Save');
    var test = el('button', { type: 'button', class: 'st-btn' }, 'Test connection');
    var remove = el('button', { type: 'button', class: 'st-btn' }, 'Remove from Home Assistant');
    actions.appendChild(save); actions.appendChild(test); actions.appendChild(remove);
    root.appendChild(actions);
    root.appendChild(el('p', { class: 'st-help' }, 'Remove clears every sensor Epilykos published and switches this off. Home Assistant needs the MQTT integration set up first.'));

    function values() {
      var mode = root.querySelector('input[name="had-mode"]:checked');
      return {
        enabled: cb.checked,
        broker: document.getElementById('had-broker').value.trim(),
        username: document.getElementById('had-user').value,
        password: document.getElementById('had-pass').value,
        prefix: document.getElementById('had-prefix').value.trim(),
        mode: mode ? mode.value : 'roles'
      };
    }
    function busy(on) { [save, test, remove].forEach(function (b) { b.disabled = on; }); }

    save.addEventListener('click', function () {
      busy(true);
      api('/settings', values()).then(function (d) { data = d; draw(); toast('Saved'); poll(); })
        .catch(function (e) { toast(e.message, 'error'); busy(false); });
    });
    test.addEventListener('click', function () {
      busy(true);
      api('/test', values()).then(function () { toast('Connected to the broker'); }).catch(function (e) { toast(e.message, 'error'); }).then(function () { busy(false); });
    });
    remove.addEventListener('click', function () {
      shell.openDialog && shell.openDialog({
        title: 'Remove from Home Assistant?',
        body: el('p', {}, 'Every Epilykos sensor is removed from Home Assistant, and this is switched off. You can turn it on again later.'),
        actions: [{ label: 'Cancel', value: null }, { label: 'Remove', value: 'ok', kind: 'danger' }]
      }).then(function (r) {
        if (!r || r.value !== 'ok') return;
        busy(true);
        api('/remove', {}).then(function (d) { data = d; draw(); toast('Removed ' + d.removed + (d.removed === 1 ? ' sensor' : ' sensors')); })
          .catch(function (e) { toast(e.message, 'error'); busy(false); });
      });
    });

    updateStatus();
  }

  var timer = null;
  function poll() {
    clearTimeout(timer);
    if (!data || !data.settings.enabled || data.status.state === 'connected' || location.hash !== '#homeassistant') return;
    timer = setTimeout(function () { api('').then(function (d) { data = d; updateStatus(); poll(); }).catch(function () {}); }, 2000);
  }

  function load() {
    return api('').then(function (d) { data = d; draw(); poll(); })
      .catch(function (e) { root.textContent = ''; root.appendChild(el('p', { class: 'st-help' }, 'Could not load: ' + e.message)); });
  }

  load();
  window.addEventListener('hashchange', function () { if (location.hash === '#homeassistant') load(); });
})();
