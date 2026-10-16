/**
 * Settings → Updates. Self-contained like Logs and System: talks to
 * /api/updates and acts at once, outside the settings form and its save bar.
 *
 *   This version   version, build date, channel
 *   Status         up to date / update ready (release notes, or "security
 *                  updates" for the weekly rebuild) and how to install it
 *   Daily check    on/off
 *
 * Loaded after settings-shell.js (window.stShell).
 */
(function () {
  'use strict';

  var root = document.getElementById('up-root');
  var checkBtn = document.getElementById('up-check');
  if (!root) return;
  var shell = window.stShell || {};
  var esc = shell.esc || function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }

  var state = null;
  var installing = false;

  async function api(method, path, body) {
    var res = await fetch('/api/updates' + path, {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function channelName(c) { return c === 'dev' ? 'Development builds' : 'Releases'; }

  function updateReady() {
    if (!state) return false;
    var host = state.host || {};
    return (state.status && state.status.state === 'available') || !!(host.app && host.app.available) || !!(host.os && host.os.available);
  }

  // ── Render ───────────────────────────────────────────────────────────
  function render() {
    if (!state) { root.innerHTML = '<p class="st-help">Loading…</p>'; return; }
    var inst = state.installed || {};
    var st = state.status || {};
    var m = state.method || {};
    var html = '';

    if (state.lastResult) html += resultCard(state.lastResult);

    html += '<div class="st-card"><div class="st-card-head"><h2>This version</h2></div>';
    if (inst.buildId) {
      html += '<p class="st-help"><b>Epilykos ' + esc(inst.version || '') + '</b> · ' + esc(channelName(inst.channel))
        + ' · built ' + esc(when(inst.builtAt)) + (inst.commit ? ' · <code>' + esc(inst.commit.slice(0, 7)) + '</code>' : '') + '</p>';
    } else {
      html += '<p class="st-help"><b>Epilykos ' + esc(inst.version || '') + '</b> · a local build (not from the published images), so there is nothing to compare with.</p>';
    }
    html += '</div>';

    if (m.kind === 'epilykos-os') html += hostCard();
    else if (inst.buildId) html += statusCard(st, m);
    else if (m.kind === 'none') html += '<div class="st-card"><div class="st-card-head"><h2>Updating</h2></div><p class="st-help">Not running in Docker. Update this copy with <code>git pull</code>, then <code>npm ci</code>, and restart it.</p></div>';

    html += '<div class="st-card"><div class="st-card-head"><h2>Daily check</h2></div>'
      + '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="up-auto"' + (state.auto ? ' checked' : '') + (state.autoLocked ? ' disabled' : '') + '><span class="slider"></span></label><label for="up-auto">Check for updates once a day</label></span>'
      + '<p class="st-help">' + (state.autoLocked ? 'Turned off for this install with <code>UPDATE_CHECK=off</code>.' : 'Only downloads a small file listing the latest builds; nothing about this install is sent. Nothing is installed without you.') + '</p></div>';

    root.innerHTML = html;
    if (shell.setNavBadge) shell.setNavBadge('updates', updateReady() ? '<span class="st-badge is-ok">New</span>' : '');
  }

  function checkedLine(st) {
    return st.checkedAt ? '<p class="st-help">Checked ' + esc(when(st.checkedAt)) + '.</p>' : '';
  }

  function statusCard(st, m) {
    var h = '<div class="st-card"><div class="st-card-head"><h2>Status</h2>';
    if (installing) {
      return h + '<span class="st-badge is-warn">Installing</span></div><p class="st-help"><b>Installing the update.</b> Epilykos restarts in a moment; this page reconnects by itself. It can take a few minutes on a Raspberry Pi.</p></div>';
    }
    if (state.applying) {
      return h + '<span class="st-badge is-warn">Installing</span></div><p class="st-help">An update started ' + esc(when(state.applying.startedAt)) + ' is still finishing.</p></div>';
    }
    if (st.state === 'available') {
      var l = st.latest || {};
      h += '<span class="st-badge is-ok">Update ready</span></div>';
      if (st.kind === 'rebuild') {
        h += '<p class="st-help"><b>Security updates are ready</b> for the system and the tools included with Epilykos (built ' + esc(when(l.builtAt)) + '). Nothing changes in how Epilykos works.</p>';
      } else {
        h += '<p class="st-help"><b>Epilykos ' + esc(l.version || '') + ' is ready</b> (built ' + esc(when(l.builtAt)) + ').</p>';
        if (st.notes && st.notes.length) h += '<ul class="st-help up-notes">' + st.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
      }
      if (st.error) h += '<p class="st-help">' + esc(st.error) + '</p>';
      h += checkedLine(st) + installPart(m);
    } else if (st.state === 'up-to-date') {
      h += '<span class="st-badge is-ok">Up to date</span></div><p class="st-help">You have the newest build.</p>' + checkedLine(st);
    } else if (st.state === 'error') {
      h += '<span class="st-badge is-error">Could not check</span></div><p class="st-help">' + esc(st.error || '') + '</p>' + checkedLine(st);
    } else {
      h += '</div><p class="st-help">Not checked yet. Use <b>Check now</b>.</p>';
    }
    return h + '</div>';
  }

  function installPart(m) {
    if (m.kind === 'docker') {
      return '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" id="up-apply">Update now</button></div>'
        + '<p class="st-help">Epilykos downloads the new version, restarts on it, and goes back to this one by itself if it does not start. Your settings and history stay.</p>';
    }
    if (m.kind === 'compose') {
      return '<p class="st-help">To install it, run these in the folder with your <code>docker-compose.yaml</code>:</p>'
        + '<pre class="up-cmd"><code>docker compose pull\ndocker compose up -d</code></pre>'
        + '<p class="st-help">For an <b>Update now</b> button here, add the Docker socket line from the latest <code>docker-compose.yaml</code>. It gives Epilykos full control of Docker on this computer, so only do this if you are comfortable with that.</p>';
    }
    return '';
  }

  function hostCard() {
    var host = state.host;
    var h = '<div class="st-card"><div class="st-card-head"><h2>Status</h2></div>';
    if (installing) return h + '<p class="st-help"><b>The appliance is installing the update.</b> The dashboard comes back by itself in a few minutes.</p></div>';
    if (!host) return h + '<p class="st-help">Not checked yet. Use <b>Check now</b>.</p></div>';
    if (host.supported === false) return h + '<p class="st-help">This EpilykosOS version installs updates on its own. Updates can be installed from here after its next update.</p></div>';
    if (host.error) return h + '<p class="st-help">The appliance could not check: ' + esc(host.error) + '</p></div>';
    var app = host.app || {}, os = host.os || {};
    h += '<div class="st-snapshots">';
    h += '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">Epilykos</span><span class="st-help"> · '
      + (app.available ? 'version ' + esc(app.latest_version || '') + ' is ready' : 'up to date') + '</span></div>'
      + (app.available ? '<button type="button" class="st-btn st-btn-primary" data-host-apply="app">Update</button>' : '') + '</div>';
    if (os.version || os.available) {
      h += '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">EpilykosOS ' + esc(os.version || '') + '</span><span class="st-help"> · '
        + (os.available ? esc(os.latest_version || 'a new version') + ' is ready' : 'up to date') + '</span></div>'
        + (os.available ? '<button type="button" class="st-btn st-btn-primary" data-host-apply="os">Update</button>' : '') + '</div>';
    }
    h += '</div>';
    if (os.available && os.notes && os.notes.length) h += '<ul class="st-help up-notes">' + os.notes.slice(0, 15).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    return h + checkedLine(host) + '</div>';
  }

  function resultCard(r) {
    var h = '<div class="st-card"><div class="st-card-head"><h2>Last update</h2>'
      + (r.ok ? '<span class="st-badge is-ok">Installed</span>' : '<span class="st-badge is-error">Failed</span>') + '</div>';
    if (r.ok) {
      h += '<p class="st-help">Updated ' + esc(when(r.finishedAt)) + (r.toBuild ? ' to build <code>' + esc(r.toBuild) + '</code>' : '') + '.</p>';
    } else {
      h += '<p class="st-help"><b>' + esc(cap(r.error) || 'The update did not finish.') + '</b>'
        + (r.rolledBack ? ' The previous version was put back, so nothing changed.' : '') + '</p>';
    }
    if (r.log && r.log.length) h += '<details><summary class="st-help">Details</summary><pre class="up-cmd"><code>' + esc(r.log.join('\n')) + '</code></pre></details>';
    return h + '<div class="st-inline-actions"><button type="button" class="st-btn" id="up-dismiss">Dismiss</button></div></div>';
  }

  // ── Load and actions ─────────────────────────────────────────────────
  async function load() {
    try { state = await api('GET', ''); }
    catch (e) { root.innerHTML = '<div class="st-card"><p class="st-help"></p></div>'; root.querySelector('p').textContent = e.message; return; }
    render();
  }

  function askPassword(title, text, label) {
    var body = document.createElement('div');
    body.innerHTML = '<p>' + esc(text) + '</p><div class="st-field"><label for="up-pw">Admin password</label><input id="up-pw" class="input" type="password" autocomplete="current-password" required></div>';
    var input = body.querySelector('input');
    setTimeout(function () { input.focus(); }, 50);
    return shell.openDialog({ title: title, body: body, actions: [{ label: 'Cancel', value: null }, { label: label, value: 'ok', kind: 'primary' }] })
      .then(function (r) { return r && r.value === 'ok' ? input.value : null; });
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /** Wait for the restart: first for this app to go away, then for an answer that is not "still installing". */
  async function waitForRestart() {
    var started = Date.now();
    await sleep(8000);
    while (Date.now() - started < 15 * 60 * 1000) {
      try {
        var data = await api('GET', '');
        if (!data.applying) { installing = false; state = data; render(); return; }
      } catch (_) { /* restarting */ }
      await sleep(5000);
    }
    installing = false;
    load();
  }

  async function install(target) {
    var isHost = state.method && state.method.kind === 'epilykos-os';
    var pw = await askPassword(target === 'os' ? 'Update EpilykosOS?' : 'Install the update?',
      isHost ? 'The appliance installs it and restarts. The dashboard is away for a few minutes.' : 'Epilykos restarts on the new version. The dashboard is away for a minute or two.',
      'Update now');
    if (pw == null) return;
    var btns = root.querySelectorAll('#up-apply, [data-host-apply]');
    btns.forEach(function (b) { b.disabled = true; b.textContent = 'Downloading…'; });
    try {
      var r = await api('POST', '/apply', { password: pw, target: target });
      if (r.state === 'current') { toast('This is already the newest version.'); await load(); return; }
      installing = true;
      render();
      waitForRestart();
    } catch (e) {
      toast(e.message, 'error');
      render();
    }
  }

  root.addEventListener('click', function (ev) {
    var btn = ev.target.closest('button');
    if (!btn || btn.disabled || !root.contains(btn)) return;
    if (btn.id === 'up-apply') install('app');
    else if (btn.dataset.hostApply) install(btn.dataset.hostApply);
    else if (btn.id === 'up-dismiss') api('POST', '/result/dismiss', {}).then(load, function (e) { toast(e.message, 'error'); });
  });

  root.addEventListener('change', function (ev) {
    if (ev.target.id !== 'up-auto') return;
    api('POST', '/auto', { on: ev.target.checked }).then(function (r) {
      state.auto = r.auto;
      toast(r.auto ? 'Daily check on.' : 'Daily check off.');
    }, function (e) { toast(e.message, 'error'); ev.target.checked = !ev.target.checked; });
  });

  if (checkBtn) checkBtn.addEventListener('click', async function () {
    checkBtn.disabled = true;
    try {
      await api('POST', '/check', {});
      await load();
      toast(updateReady() ? 'An update is ready.' : (state.status && state.status.state === 'error') ? 'Could not check for updates.' : 'You are up to date.', state.status && state.status.state === 'error' ? 'error' : undefined);
    } catch (e) { toast(e.message, 'error'); }
    finally { checkBtn.disabled = false; }
  });

  load();
})();
