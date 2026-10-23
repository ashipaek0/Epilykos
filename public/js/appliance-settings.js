/** Host clock/storage and a bounded BlueZ pairing wizard. */
(function () {
  'use strict';
  var system = document.getElementById('sys-root');
  if (!system) return;
  var root = document.createElement('div'); system.after(root);
  var initialized = false, bt = null, lastBt = '', refreshing = false, lastRefresh = 0, refreshFailed = false, notAppliance = false;
  // A reply that isn't JSON came from something in front of Epilykos (the remote
  // link's error page while the app restarts, say), not from Epilykos.
  var NOT_ANSWERING = 'Epilykos didn\u2019t answer (it may be restarting). This page tries again by itself.';
  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  async function api(path, body) {
    var r = await fetch('/api/system' + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body) });
    var d;
    try { d = await r.json(); } catch (_) { throw new Error(NOT_ANSWERING); }
    if (!r.ok) throw new Error(d.error || 'The appliance refused the action'); return d;
  }
  // Each card has its own status line: 'time' or 'bt'.
  function message(s, where) {
    var el = root.querySelector('[data-status="' + (where || 'bt') + '"]');
    if (el) { el.className = 'test-status' + (s ? ' error' : ''); el.textContent = s; }
  }
  function note(s, where) {
    var el = root.querySelector('[data-status="' + where + '"]');
    if (el) { el.className = 'test-status success'; el.textContent = s; }
  }
  function row(label, key) {
    return '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">' + label + '</span><span class="st-help" ' + key + '></span></div></div>';
  }
  function renderHost(s) {
    if (!initialized) {
      root.innerHTML = '<div class="st-card"><div class="st-card-head"><h2>Time and storage</h2></div>'
        + '<div class="st-snapshots">' + row('Clock', 'data-clock-status') + row('SD card', 'data-storage-status') + row('DATA', 'data-data-storage-status role="status"') + '</div>'
        + '<div class="st-field" style="margin-top:14px"><label for="sys-timezone">Site time zone</label><input class="input" id="sys-timezone" value="' + esc((s.clock || {}).timezone || 'UTC') + '" placeholder="Africa/Lagos"><span class="st-help">Use an IANA name. Daily totals follow this zone; changing it restarts Epilykos.</span></div>'
        + '<div class="st-inline-actions"><button class="st-btn" type="button" data-extra="timezone">Save time zone</button><button class="st-btn" type="button" data-extra="clock">Set time from this browser</button></div>'
        + '<div class="test-status" data-status="time" role="status"></div></div>'
        + '<div class="st-card"><div class="st-card-head"><h2>Bluetooth devices</h2></div><p class="st-help">Pair a device here if its source needs a PIN or a bond. Pairing does not add a source or add support for its protocol. Select the device in source settings afterwards. Nearby devices can be paired only during the five-minute window.</p>'
        + '<div data-bt></div><div class="test-status" data-status="bt" role="status"></div></div>';
      initialized = true;
    }
    var clock = s.clock || {};
    root.querySelector('[data-clock-status]').textContent = clock.epoch ? ' · ' + new Date(clock.epoch*1000).toLocaleString() + ' · ' + clock.timezone + ' · ' + (clock.synchronized ? 'network time synchronized' : 'not synchronized; connect to the Internet or set it below') : ' · unavailable on this OS version';
    var storage = s.storage;
    root.querySelector('[data-storage-status]').textContent = storage ? ' · ' + (storage.bytes/1e9).toFixed(1) + ' GB' + (storage.undersized ? ' — below the 32 GB minimum; snapshots and restores may not fit. Use 64 GB if possible.' : ' · 64 GB recommended') : ' · size unavailable';
    var space = s.data_storage;
    var GiB = 1073741824;
    root.querySelector('[data-data-storage-status]').textContent = space && space.available
      ? ' · ' + (space.available_bytes/GiB).toFixed(1) + ' GiB free of ' + (space.total_bytes/GiB).toFixed(1) + ' GiB'
        + (space.state === 'critical' ? ' · critically low' : space.state === 'warning' ? ' · low' : '')
        + ' · keep at least ' + (Math.ceil(space.maintenance_floor_bytes/GiB*10)/10).toFixed(1) + ' GiB free after maintenance'
      : ' · free space unavailable';
  }
  function renderBluetooth(state) {
    bt = state;
    var box = root.querySelector('[data-bt]'); if (!box) return;
    var serialized = JSON.stringify(state);
    if (serialized === lastBt) return;
    // Keep a partially typed PIN across polls, until the actual request changes/expires.
    var input = box.querySelector('#sys-bt-pin');
    if (input && state.pending && input.dataset.request === state.pending.id) return;
    lastBt = serialized;
    if (!state.available) { box.innerHTML = '<p class="st-help">Bluetooth is not ready. Check that the adapter is available; this page retries.</p>'; return; }
    var open = state.until > Date.now()/1000;
    var h = '<p class="st-help"><b>' + (open ? 'Pairing is open until ' + esc(new Date(state.until*1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '.' : 'Pairing is closed.') + '</b></p>'
      + '<div class="st-inline-actions"><button type="button" class="st-btn" data-extra="' + (open ? 'bt-close' : 'bt-open') + '">' + (open ? 'Close pairing' : 'Pair a Bluetooth device') + '</button></div>';
    if (state.result) h += '<p class="st-help" role="status">' + esc(state.result.message) + '</p>';
    if (state.pairing) h += '<p class="st-help">Pairing… keep the device nearby.</p>';
    var pending = state.pending;
    if (pending) {
      if (pending.kind === 'display') h += '<p class="st-help">Enter this code on the device: <b>' + esc(pending.value) + '</b></p>';
      else if (pending.kind === 'confirm') h += '<p class="st-help">Does the device show <b>' + esc(pending.value) + '</b>?</p><div class="st-inline-actions"><button class="st-btn st-btn-primary" type="button" data-extra="bt-confirm">Codes match</button><button class="st-btn" type="button" data-extra="bt-reject">Reject</button></div>';
      else h += '<div class="st-field"><label for="sys-bt-pin">Device ' + (pending.kind === 'pin' ? 'PIN' : 'numeric passkey') + '</label><input type="password" autocomplete="off" class="input" id="sys-bt-pin" data-request="' + esc(pending.id) + '" maxlength="16" style="max-width:14em"></div><div class="st-inline-actions"><button class="st-btn st-btn-primary" type="button" data-extra="bt-reply">Send PIN</button></div>';
    }
    var devices = (state.devices || []).filter(function (d) { return open || d.paired; });
    if (devices.length) {
      h += '<div class="st-snapshots" style="margin-top:12px">' + devices.map(function (d) {
        return '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">' + esc(d.name) + '</span>'
          + '<span class="st-help"> · <code>' + esc(d.address) + '</code> · ' + (d.paired ? 'paired' : 'nearby') + (d.connected ? ' · connected' : '') + '</span></div>'
          + '<button class="st-btn" type="button" data-extra="' + (d.paired ? 'bt-remove' : 'bt-pair') + '" data-address="' + esc(d.address) + '"' + (state.pairing ? ' disabled' : '') + '>' + (d.paired ? 'Forget' : 'Pair') + '</button></div>';
      }).join('') + '</div>';
    } else if (open) {
      h += '<p class="st-help">Looking for nearby devices… put the device in pairing mode.</p>';
    }
    box.innerHTML = h;
  }
  async function refresh() {
    if (refreshing) return; refreshing = true; lastRefresh = Date.now();
    try {
      var s = await api(''); if (!s.appliance) { notAppliance = true; return; } renderHost(s); var r = await api('/bluetooth'); renderBluetooth(r.bluetooth);
      // An error from an earlier refresh is over once one works (a button's error stays).
      if (refreshFailed) { refreshFailed = false; message('', 'bt'); }
    }
    catch (e) { refreshFailed = true; message(e.message, 'bt'); }
    finally { refreshing = false; }
  }
  root.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-extra]'); if (!b) return;
    var act = b.dataset.extra;
    var where = act === 'timezone' || act === 'clock' ? 'time' : 'bt';
    if (act === 'bt-remove') {
      var ask = { title: 'Forget ' + b.dataset.address + '?', message: 'Its source will need pairing again.', confirmLabel: 'Forget' };
      if (!(await (window.stConfirm ? window.stConfirm(ask) : Promise.resolve(window.confirm(ask.title + ' ' + ask.message))))) return;
    }
    b.disabled = true;
    try {
      if (act === 'timezone') {
        await api('/timezone', {timezone: root.querySelector('#sys-timezone').value.trim()});
        note('Time zone saved. Epilykos is restarting…', 'time'); setTimeout(function () { location.reload(); }, 15000);
      } else if (act === 'clock') {
        await api('/clock', {epoch: Math.floor(Date.now()/1000)}); await refresh(); note('Clock set from this browser. Network time remains enabled.', 'time');
      } else {
        var path, body = {};
        if (act === 'bt-open') path = '/bluetooth/open';
        if (act === 'bt-close') path = '/bluetooth/close';
        if (act === 'bt-pair' || act === 'bt-remove') {
          path = act === 'bt-pair' ? '/bluetooth/pair' : '/bluetooth/remove'; body.address = b.dataset.address;
        }
        if (act === 'bt-reply' || act === 'bt-confirm' || act === 'bt-reject') {
          path = '/bluetooth/reply'; body.id = bt.pending.id;
          body.value = act === 'bt-reply' ? root.querySelector('#sys-bt-pin').value : act === 'bt-confirm';
        }
        if (!path) return;
        var r = await api(path, body);
        var pin = root.querySelector('#sys-bt-pin'); if (pin) pin.value = '';
        lastBt = ''; renderBluetooth(r.bluetooth); message('', 'bt');
      }
    } catch (err) { message(err.message, where); }
    finally { b.disabled = false; }
  });
  // Every 2 s while pairing is open (nearby devices and PIN requests come and
  // go), otherwise every 30 s; not at all while the tab or section is hidden.
  // Not waiting for a first load that worked: one that failed (Epilykos restarting) is tried again too.
  function shown() { return !notAppliance && !document.hidden && !document.getElementById('section-system').hidden; }
  function pairing() { return !!(bt && (bt.until > Date.now()/1000 || bt.pending || bt.pairing)); }
  refresh(); setInterval(function () { if (shown() && (pairing() || Date.now() - lastRefresh >= 30000)) refresh(); }, 2000);
  document.addEventListener('visibilitychange', function () { if (shown()) refresh(); });
  document.addEventListener('st:section-shown', function(e) { if (e.detail && e.detail.section === 'system') refresh(); });
})();
