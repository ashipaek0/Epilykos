/** Host clock/storage and a bounded BlueZ pairing wizard. */
(function () {
  'use strict';
  var system = document.getElementById('sys-root');
  if (!system) return;
  var root = document.createElement('div'); system.after(root);
  var initialized = false, bt = null, lastBt = '', refreshing = false;
  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  async function api(path, body) {
    var r = await fetch('/api/system' + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body) });
    var d = await r.json(); if (!r.ok) throw new Error(d.error || 'The appliance refused the action'); return d;
  }
  function message(s) { var el = root.querySelector('[data-extra-status]'); if (el) el.textContent = s; }
  function renderHost(s) {
    if (!initialized) {
      root.innerHTML = '<div class="st-card"><h2>Time and storage</h2><p data-clock-status></p><p data-storage-status></p>'
        + '<div class="st-field"><label for="sys-timezone">Site time zone</label><input class="input" id="sys-timezone" value="' + esc((s.clock || {}).timezone || 'UTC') + '" placeholder="Africa/Lagos"><p class="st-help">Use an IANA name. Daily totals follow this zone; changing it restarts Epilykos.</p></div>'
        + '<button class="st-btn" type="button" data-extra="timezone">Save time zone</button> <button class="st-btn" type="button" data-extra="clock">Set time from this browser</button></div>'
        + '<div class="st-card"><h2>Bluetooth devices</h2><p class="st-help">Pair a device here if its source needs a PIN or a bond. Pairing does not add a source or add support for its protocol. Select the device in source settings afterwards. Nearby devices can be paired only during the five-minute window.</p><div data-bt></div></div><p role="status" data-extra-status></p>';
      initialized = true;
    }
    var clock = s.clock || {};
    root.querySelector('[data-clock-status]').textContent = clock.epoch ? new Date(clock.epoch*1000).toLocaleString() + ' · ' + clock.timezone + ' · ' + (clock.synchronized ? 'network time synchronized' : 'clock not synchronized; connect to the Internet or correct it below') : 'Clock state unavailable on this OS version.';
    var storage = s.storage;
    root.querySelector('[data-storage-status]').textContent = storage ? (storage.bytes/1e9).toFixed(1) + ' GB card' + (storage.undersized ? ' — below the 32 GB minimum; snapshots and restores may not fit. Use 64 GB if possible.' : ' · 64 GB recommended.') : 'Card size unavailable.';
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
    if (!state.available) { box.innerHTML = '<p>Bluetooth is not ready. Check that the adapter is available; this page retries.</p>'; return; }
    var open = state.until > Date.now()/1000;
    var h = '<p>' + (open ? 'Pairing is open until ' + esc(new Date(state.until*1000).toLocaleTimeString()) : 'Pairing is closed.') + '</p>'
      + '<button type="button" class="st-btn" data-extra="' + (open ? 'bt-close' : 'bt-open') + '">' + (open ? 'Close pairing' : 'Pair a Bluetooth device') + '</button>';
    if (state.result) h += '<p role="status">' + esc(state.result.message) + '</p>';
    if (state.pairing) h += '<p>Pairing… keep the device nearby.</p>';
    var pending = state.pending;
    if (pending) {
      if (pending.kind === 'display') h += '<p>Enter this code on the device: <b>' + esc(pending.value) + '</b></p>';
      else if (pending.kind === 'confirm') h += '<p>Does the device show <b>' + esc(pending.value) + '</b>?</p><button class="st-btn" type="button" data-extra="bt-confirm">Codes match</button> <button class="st-btn" type="button" data-extra="bt-reject">Reject</button>';
      else h += '<div class="st-field"><label for="sys-bt-pin">Device ' + (pending.kind === 'pin' ? 'PIN' : 'numeric passkey') + '</label><input type="password" autocomplete="off" class="input" id="sys-bt-pin" data-request="' + esc(pending.id) + '" maxlength="16"></div><button class="st-btn" type="button" data-extra="bt-reply">Send PIN</button>';
    }
    (state.devices || []).forEach(function (d) {
      if (!open && !d.paired) return;
      h += '<p><b>' + esc(d.name) + '</b> · <code>' + esc(d.address) + '</code> · ' + (d.paired ? 'Paired' : 'Nearby') + (d.connected ? ' · connected' : '') + ' <button class="st-btn" type="button" data-extra="' + (d.paired ? 'bt-remove' : 'bt-pair') + '" data-address="' + esc(d.address) + '"' + (state.pairing ? ' disabled' : '') + '>' + (d.paired ? 'Forget' : 'Pair') + '</button></p>';
    });
    box.innerHTML = h;
  }
  async function refresh() {
    if (refreshing) return; refreshing = true;
    try { var s = await api(''); if (!s.appliance) return; renderHost(s); var r = await api('/bluetooth'); renderBluetooth(r.bluetooth); }
    catch (e) { message(e.message); }
    finally { refreshing = false; }
  }
  root.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-extra]'); if (!b) return;
    var act = b.dataset.extra;
    b.disabled = true;
    try {
      if (act === 'timezone') {
        await api('/timezone', {timezone: root.querySelector('#sys-timezone').value.trim()});
        message('Time zone saved. Epilykos is restarting…'); setTimeout(function () { location.reload(); }, 15000);
      } else if (act === 'clock') {
        await api('/clock', {epoch: Math.floor(Date.now()/1000)}); message('Clock set from this browser. Network time remains enabled.'); await refresh();
      } else {
        var path, body = {};
        if (act === 'bt-open') path = '/bluetooth/open';
        if (act === 'bt-close') path = '/bluetooth/close';
        if (act === 'bt-pair' || act === 'bt-remove') {
          if (act === 'bt-remove' && !window.confirm('Forget ' + b.dataset.address + '? Its source will need pairing again.')) return;
          path = act === 'bt-pair' ? '/bluetooth/pair' : '/bluetooth/remove'; body.address = b.dataset.address;
        }
        if (act === 'bt-reply' || act === 'bt-confirm' || act === 'bt-reject') {
          path = '/bluetooth/reply'; body.id = bt.pending.id;
          body.value = act === 'bt-reply' ? root.querySelector('#sys-bt-pin').value : act === 'bt-confirm';
        }
        if (!path) return;
        var r = await api(path, body);
        var pin = root.querySelector('#sys-bt-pin'); if (pin) pin.value = '';
        lastBt = ''; renderBluetooth(r.bluetooth); message('');
      }
    } catch (err) { message(err.message); }
    finally { b.disabled = false; }
  });
  refresh(); setInterval(function () { if (initialized && !document.getElementById('section-system').hidden) refresh(); }, 2000);
  document.addEventListener('st:section-shown', function(e) { if (e.detail && e.detail.section === 'system') refresh(); });
})();
