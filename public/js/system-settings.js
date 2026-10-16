/**
 * Settings → System (EpilykosOS appliances only; contract C-HOST-001).
 * Self-contained like the Notifications section: talks to /api/system and
 * acts at once, outside the settings form and its save bar.
 *
 *   Power   Restart, Shut down
 *   Wi-Fi   Change Wi-Fi: opens Bluetooth setup for 15 minutes
 *   SSH     on/off, password, public keys (user epilykos; never root)
 *
 * The nav entry stays hidden unless /api/system reports an appliance.
 * Loaded after settings-shell.js (window.stShell, window.stConfirm).
 */
(function () {
  'use strict';

  var root = document.getElementById('sys-root');
  var navItem = document.getElementById('st-nav-system');
  if (!root) return;
  var shell = window.stShell || {};
  var esc = shell.esc || function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }
  function confirmIt(o) { return window.stConfirm ? window.stConfirm(o) : Promise.resolve(window.confirm(o.message)); }

  var state = null;

  async function api(method, path, body) {
    var res = await fetch('/api/system' + path, {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  function host() {
    return location.hostname || 'epilykos.local';
  }

  function untilText(epoch) {
    return new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Render ───────────────────────────────────────────────────────────
  function render() {
    if (!state) { root.innerHTML = '<p class="st-help">Loading…</p>'; return; }
    if (state.error) {
      root.innerHTML = '<div class="st-card"><p class="st-help"></p></div>';
      root.querySelector('p').textContent = 'The appliance\'s system service did not answer: ' + state.error;
      return;
    }
    var ssh = state.ssh || { enabled: false, password_set: false, keys: [], user: 'epilykos' };
    var now = Date.now() / 1000;
    var wifiOpen = state.wifi_setup_until && state.wifi_setup_until > now;
    var html = '';

    html += '<div class="st-card"><div class="st-card-head"><h2>Power</h2></div>'
      + '<p class="st-help">Restart or shut down the whole appliance. Epilykos stops cleanly first, so nothing is lost.'
      + ' After shutting down, unplug the power once the green light on the board stops flashing.</p>'
      + '<div class="st-inline-actions"><button type="button" class="st-btn" data-act="restart">Restart</button>'
      + '<button type="button" class="st-btn st-btn-danger" data-act="shutdown">Shut down</button></div>'
      + '<div class="test-status" id="sys-power-status" role="status"></div></div>';

    html += '<div class="st-card"><div class="st-card-head"><h2>Wi-Fi</h2></div>'
      + '<p class="st-help">To join a different Wi-Fi network, open Bluetooth setup, then on a phone or computer with Chrome go to '
      + '<a href="https://www.improv-wifi.com" target="_blank" rel="noopener">improv-wifi.com</a>, choose <b>Connect device to Wi-Fi</b> and pick <b>Epilykos</b>.'
      + ' Setup also opens by itself if the box has had no network for 2 minutes.</p>'
      + (wifiOpen ? '<p class="st-help"><b>Bluetooth setup is open until ' + esc(untilText(state.wifi_setup_until)) + '.</b></p>' : '')
      + '<div class="st-inline-actions"><button type="button" class="st-btn" data-act="wifi">' + (wifiOpen ? 'Keep setup open 15 more minutes' : 'Change Wi-Fi') + '</button></div>'
      + '<div class="test-status" id="sys-wifi-status" role="status"></div></div>';

    html += '<div class="st-card"><div class="st-card-head"><h2>SSH maintenance login</h2>'
      + '<span class="st-badge" style="background:var(--st-hover)">' + (ssh.enabled ? 'On' : 'Off') + '</span></div>'
      + '<p class="st-help">For maintenance from another computer. Log in as <code>' + esc(ssh.user) + '</code>, which can use <code>sudo</code>; root can never log in over SSH.'
      + (ssh.enabled ? ' Connect with <code>ssh ' + esc(ssh.user) + '@' + esc(host()) + '</code>.' : '') + '</p>'
      + '<div class="st-inline-actions"><button type="button" class="st-btn' + (ssh.enabled ? '' : ' st-btn-primary') + '" data-act="ssh-toggle">' + (ssh.enabled ? 'Turn SSH off' : 'Turn SSH on') + '</button></div>'
      + (ssh.enabled && !ssh.password_set && !ssh.keys.length ? '<p class="st-help"><b>Set a password or add a key below — until then nobody can log in.</b></p>' : '')
      + '<div class="test-status" id="sys-ssh-status" role="status"></div>';

    html += '<h3 class="st-help" style="margin:18px 0 6px;font-weight:800">Password</h3>'
      + '<p class="st-help">' + (ssh.password_set ? 'A password is set.' : 'No password: only the keys below can log in.') + '</p>'
      + '<div class="st-field"><label for="sys-ssh-pw">' + (ssh.password_set ? 'New password' : 'Password') + '</label>'
      + '<input id="sys-ssh-pw" class="input" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="At least 8 characters"></div>'
      + '<div class="st-inline-actions"><button type="button" class="st-btn" data-act="ssh-password">Save password</button>'
      + (ssh.password_set ? '<button type="button" class="st-btn" data-act="ssh-clear">Remove password</button>' : '') + '</div>';

    html += '<h3 class="st-help" style="margin:18px 0 6px;font-weight:800">Public keys</h3>';
    if (ssh.keys.length) {
      html += '<div class="st-snapshots">' + ssh.keys.map(function (k) {
        return '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">' + esc(k.comment || k.type) + '</span>'
          + '<span class="st-help"> · ' + esc(k.type) + ' · <code style="word-break:break-all">' + esc(k.fingerprint) + '</code></span></div>'
          + '<button type="button" class="st-btn" data-remove-key="' + esc(k.fingerprint) + '">Remove</button></div>';
      }).join('') + '</div>';
    } else {
      html += '<p class="st-help">No keys yet.</p>';
    }
    html += '<div class="st-field" style="margin-top:10px"><label for="sys-ssh-key">Add a public key</label>'
      + '<textarea id="sys-ssh-key" class="input" rows="3" spellcheck="false" placeholder="ssh-ed25519 AAAA… you@laptop"></textarea>'
      + '<span class="st-help">Paste the contents of a <code>.pub</code> file, e.g. <code>~/.ssh/id_ed25519.pub</code>. Never paste a private key.</span></div>'
      + '<div class="st-inline-actions"><button type="button" class="st-btn" data-act="ssh-add-key">Add key</button></div>'
      + '</div>';

    root.innerHTML = html;
  }

  function status(id, msg, tone) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'test-status' + (tone ? ' ' + tone : '');
    el.textContent = msg || '';
  }

  // ── Load ─────────────────────────────────────────────────────────────
  async function load() {
    try {
      var data = await api('GET', '');
      if (!data.appliance) { if (navItem) navItem.hidden = true; return data; }
      state = data;
    } catch (e) {
      state = { error: e.message };
    }
    if (navItem) navItem.hidden = false;
    render();
    return state;
  }

  // ── Actions ──────────────────────────────────────────────────────────
  async function waitForReturn() {
    // The box comes back with the same address; reload once it answers.
    var started = Date.now();
    await new Promise(function (r) { setTimeout(r, 15000); });
    while (Date.now() - started < 10 * 60 * 1000) {
      try {
        var res = await fetch('/healthz', { cache: 'no-store' });
        if (res.ok) { location.reload(); return; }
      } catch (_) { /* still down */ }
      await new Promise(function (r) { setTimeout(r, 5000); });
    }
  }

  root.addEventListener('click', async function (ev) {
    var btn = ev.target.closest('button');
    if (!btn || !root.contains(btn)) return;
    var act = btn.dataset.act;
    var removeKey = btn.dataset.removeKey;
    try {
      if (act === 'restart') {
        if (!(await confirmIt({ title: 'Restart the appliance?', message: 'Epilykos stops, the box restarts, and the dashboard comes back in a minute or two.', confirmLabel: 'Restart' }))) return;
        btn.disabled = true;
        await api('POST', '/restart');
        status('sys-power-status', 'Restarting… this page reloads when Epilykos is back.', 'warning');
        waitForReturn();
      } else if (act === 'shutdown') {
        if (!(await confirmIt({ title: 'Shut down the appliance?', message: 'Monitoring stops until the power is unplugged and plugged back in.', confirmLabel: 'Shut down' }))) return;
        btn.disabled = true;
        await api('POST', '/shutdown');
        status('sys-power-status', 'Shutting down. Unplug the power once the green light on the board stops flashing.', 'warning');
      } else if (act === 'wifi') {
        var r = await api('POST', '/wifi-setup');
        state.wifi_setup_until = r.wifi_setup_until;
        render();
        status('sys-wifi-status', 'Bluetooth setup is open until ' + untilText(r.wifi_setup_until) + '.', 'success');
      } else if (act === 'ssh-toggle') {
        var turningOn = !state.ssh.enabled;
        if (!turningOn && !(await confirmIt({ title: 'Turn SSH off?', message: 'Open SSH sessions are closed. The password and keys are kept for next time.', confirmLabel: 'Turn off' }))) return;
        state.ssh = (await api('POST', turningOn ? '/ssh/enable' : '/ssh/disable')).ssh;
        render();
        status('sys-ssh-status', turningOn ? 'SSH is on.' : 'SSH is off.', 'success');
      } else if (act === 'ssh-password') {
        var pw = document.getElementById('sys-ssh-pw').value;
        if (pw.length < 8) { status('sys-ssh-status', 'The password needs at least 8 characters.', 'error'); return; }
        state.ssh = (await api('POST', '/ssh/password', { password: pw })).ssh;
        render();
        status('sys-ssh-status', 'SSH password saved.', 'success');
      } else if (act === 'ssh-clear') {
        if (!(await confirmIt({ title: 'Remove the SSH password?', message: 'Only the public keys can log in afterwards.', confirmLabel: 'Remove' }))) return;
        state.ssh = (await api('POST', '/ssh/password/clear')).ssh;
        render();
        status('sys-ssh-status', 'SSH password removed.', 'success');
      } else if (act === 'ssh-add-key') {
        var key = document.getElementById('sys-ssh-key').value.trim();
        if (/PRIVATE KEY/.test(key)) { status('sys-ssh-status', 'That is a private key. Paste the .pub file instead, and keep the private key secret.', 'error'); return; }
        state.ssh = (await api('POST', '/ssh/keys', { key: key })).ssh;
        render();
        status('sys-ssh-status', 'Key added.', 'success');
      } else if (removeKey) {
        if (!(await confirmIt({ title: 'Remove this key?', message: 'Whoever holds it can no longer log in.', confirmLabel: 'Remove' }))) return;
        state.ssh = (await api('POST', '/ssh/keys/remove', { fingerprint: removeKey })).ssh;
        render();
        status('sys-ssh-status', 'Key removed.', 'success');
      }
    } catch (e) {
      btn.disabled = false;
      var target = /^ssh|^$/.test(act || '') || removeKey ? 'sys-ssh-status' : act === 'wifi' ? 'sys-wifi-status' : 'sys-power-status';
      status(target, e.message, 'error');
      toast(e.message, 'error');
    }
  });

  document.addEventListener('st:section-shown', function (ev) {
    if (ev.detail && ev.detail.section === 'system') load();
  });
  load();
})();
