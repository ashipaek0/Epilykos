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
    return (state.status && state.status.state === 'available') || !!(host.app && host.app.available) || !!(state.os && state.os.available);
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

    if (m.kind === 'epilykos-os') html += hostCard() + osCard();
    else if (inst.buildId) html += statusCard(st, m);
    else if (m.kind === 'none') html += '<div class="st-card"><div class="st-card-head"><h2>Updating</h2></div><p class="st-help">Not running in Docker. Update this copy with <code>git pull</code>, then <code>npm ci</code>, and restart it.</p></div>';

    html += '<div class="st-card"><div class="st-card-head"><h2>Daily check</h2></div>'
      + '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="up-auto"' + (state.auto ? ' checked' : '') + (state.autoLocked ? ' disabled' : '') + '><span class="slider"></span></label><label for="up-auto">Check for updates once a day</label></span>'
      + '<p class="st-help">' + (state.autoLocked ? 'Turned off for this install with <code>UPDATE_CHECK=off</code>.' : 'Only downloads a small file listing the latest builds; nothing about this install is sent.' + (m.kind === 'epilykos-os' ? ' Installation is manual unless you turn on automatic installation below.' : '')) + '</p></div>';

    if (m.kind === 'epilykos-os') html += autoInstallCard();
    root.innerHTML = html;
    if (shell.setNavBadge) shell.setNavBadge('updates', updateReady() ? '<span class="st-badge is-ok">New</span>' : '');
    schedulePoll();
  }

  function autoInstallCard() {
    var on = !!state.autoInstall;
    var h = '<div class="st-card"><div class="st-card-head"><h2>Automatic app installation</h2></div>';
    h += '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="up-install-auto"' + (on ? ' checked' : '')
      + (state.auto ? '' : ' disabled') + '><span class="slider"></span></label><label for="up-install-auto">Install signed app releases automatically</label></span>';
    h += '<p class="st-help">' + (state.auto ? '' : '<b>Turn on the daily check first.</b> ')
      + 'Turning it on asks for your admin password. The host verifies the signature, checks health and rolls back a failed update. Each release is tried automatically at most once; a failed release can be retried manually. Epilykos restarts during installation. OS image updates remain manual.</p>';
    return h + '</div>';
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
    if (state.applying) return h + '<p class="st-help"><b>The appliance is installing an update</b> (started ' + esc(when(state.applying.startedAt)) + '). The dashboard restarts on the new version when it is ready.</p></div>';
    if (!host) return h + '<p class="st-help">Not checked yet. Use <b>Check now</b>.</p></div>';
    if (host.supported === false) return h + '<p class="st-help">This EpilykosOS version installs updates on its own. Updates can be installed from here after its next update.</p></div>';
    if (host.error) return h + '<p class="st-help">The appliance could not check: ' + esc(host.error) + '</p></div>';
    var app = host.app || {};
    h += '<div class="st-snapshots">';
    h += '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">Epilykos</span><span class="st-help"> · '
      + (app.available ? 'version ' + esc(app.latest_version || '') + ' is ready' : app.error ? esc(app.error) : 'up to date') + '</span></div>'
      + (app.available ? '<button type="button" class="st-btn st-btn-primary" data-host-apply="app">Update</button>' : '') + '</div>';
    h += '</div>';
    return h + checkedLine(host) + '</div>';
  }

  // ── EpilykosOS (the system itself) ───────────────────────────────────
  var OS_WORKING = ['queued', 'downloading', 'verifying', 'installing', 'restarting', 'trying'];
  var OS_CANCELLABLE = ['queued', 'downloading', 'verifying'];
  function mb(n) { return (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB'; }

  function osProgress(job) {
    if (job.state === 'queued') return 'Starting…';
    if (job.state === 'downloading') return job.total ? 'Downloading ' + mb(job.bytes || 0) + ' / ' + mb(job.total) : 'Downloading…';
    if (job.state === 'verifying') return 'Verifying the signature and contents…';
    if (job.state === 'installing') return 'Installing' + (job.percent != null ? ' ' + job.percent + ' %' : '…');
    if (job.state === 'restarting') return 'Restarting onto the new system…';
    if (job.state === 'trying') return 'The new system is starting. It is kept once it has run properly; otherwise the box goes back to the previous version by itself.';
    if (job.state === 'reconciling') return 'EpilykosOS is checking an update that was interrupted.';
    return '';
  }

  function osResult(r, os) {
    var v = esc(r.version || 'the new version');
    var text = r.outcome === 'confirmed' ? 'Updated to EpilykosOS ' + v + '.'
      : r.outcome === 'rolled_back' ? v + ' didn\u2019t start properly; the box went back to ' + esc(os.version || 'the previous version') + (r.reason ? ' (' + esc(r.reason) + ')' : '') + '.'
        : r.outcome === 'cancelled' ? 'The system update was cancelled.'
          : r.outcome === 'discarded' ? 'The prepared system update was discarded; nothing changed.'
            : 'The system update did not finish' + (r.reason ? ': ' + esc(r.reason) : '') + '. Nothing changed.';
    return '<p class="st-help"><b>' + text + '</b></p><div class="st-inline-actions"><button type="button" class="st-btn" data-os-dismiss="' + esc(r.id) + '">Dismiss</button></div>';
  }

  function osCard() {
    var os = state.os;
    var h = '<div class="st-card" id="up-os"><div class="st-card-head"><h2>EpilykosOS</h2>';
    if (!os) return h + '</div><p class="st-help">The appliance is not answering right now.</p></div>';
    if (!os.supported) return h + '</div><p class="st-help">' + esc(os.unsupported_reason || '') + '</p></div>';
    var job = os.job;
    if (job && job.state === 'ready') {
      h += '<span class="st-badge is-warn">Restart to finish</span></div>'
        + '<p class="st-help"><b>EpilykosOS ' + esc(job.version || '') + ' is installed and ready.</b> '
        + 'Monitoring stops for a few minutes while the new system starts. If it doesn\u2019t start properly, the box goes back to this version by itself.</p>'
        + (job.error ? '<p class="st-help">' + esc(job.error) + '</p>' : '')
        + '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" data-os-restart="' + esc(job.id) + '">Restart to finish</button>'
        + '<button type="button" class="st-btn" data-os-discard="' + esc(job.id) + '">Discard</button></div>';
      return h + '</div>';
    }
    if (job) {
      h += '<span class="st-badge is-warn">' + (job.state === 'reconciling' ? 'Checking' : 'Updating') + '</span></div>'
        + '<p class="st-help"><b>EpilykosOS ' + esc(job.version || '') + '</b> · <span class="up-os-progress">' + esc(osProgress(job)) + '</span></p>'
        + (job.state === 'downloading' || job.state === 'verifying' || job.state === 'installing'
          ? '<p class="st-help">Monitoring keeps running. You can close this page; the appliance carries on.</p>' : '')
        + (OS_CANCELLABLE.indexOf(job.state) !== -1 ? '<div class="st-inline-actions"><button type="button" class="st-btn" data-os-cancel="' + esc(job.id) + '">Cancel</button></div>' : '');
      return h + '</div>';
    }
    var latest = os.latest;
    h += (os.available ? '<span class="st-badge is-ok">Update ready</span>' : '<span class="st-badge is-ok">Up to date</span>') + '</div>';
    if (os.last_result) h += osResult(os.last_result, os);
    h += '<p class="st-help">This system: <b>EpilykosOS ' + esc(os.version || '') + '</b>.</p>';
    if (os.error) h += '<p class="st-help">' + esc(os.error) + '</p>';
    if (os.available && latest) {
      h += '<p class="st-help"><b>EpilykosOS ' + esc(latest.version) + ' is ready</b>' + (latest.size ? ' (' + mb(latest.size) + ')' : '')
        + (latest.notes_url ? ' · <a href="' + esc(latest.notes_url) + '" target="_blank" rel="noopener">Release notes</a>' : '') + '.</p>';
      var blockers = os.blockers || [];
      if (blockers.length) h += '<ul class="st-help up-notes">' + blockers.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>';
      h += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" data-os-install="' + esc(latest.sequence) + '"'
        + (blockers.length ? ' disabled' : '') + '>Install</button></div>'
        + '<p class="st-help">It installs into the other system slot while monitoring keeps running; you choose when to restart.</p>';
    }
    return h + '</div>';
  }

  // While a system update runs, look every 2 s (backing off when the box is away).
  var osTimer = null, osDelay = 2000;
  function osWorking() { return !!(state && state.os && state.os.job && OS_WORKING.concat(['reconciling']).indexOf(state.os.job.state) !== -1); }
  function schedulePoll() {
    if (osTimer || !osWorking()) return;
    osTimer = setTimeout(async function () {
      osTimer = null;
      if (document.hidden) { schedulePoll(); return; }
      try { state = await api('GET', ''); osDelay = 2000; render(); }
      catch (_) { osDelay = Math.min(osDelay * 2, 30000); }
      schedulePoll();
    }, osDelay);
  }

  function requestId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  async function osAction(path, body, confirm) {
    if (confirm) {
      var pw = await askPassword(confirm.title, confirm.text, confirm.label);
      if (pw == null) return;
      body.password = pw;
    }
    try {
      var r = await api('POST', '/os/' + path, body);
      if (r.os) state.os = r.os;
      render();
    } catch (e) { toast(e.message, 'error'); await load(); }
  }

  function resultCard(r) {
    var h = '<div class="st-card"><div class="st-card-head"><h2>Last update</h2>'
      + (r.ok ? '<span class="st-badge is-ok">Installed</span>' : '<span class="st-badge is-error">Failed</span>') + '</div>';
    if (r.ok) {
      h += '<p class="st-help">Updated ' + esc(when(r.finishedAt)) + (r.toVersion ? ' to ' + esc(r.toVersion) : r.toBuild ? ' to build <code>' + esc(r.toBuild) + '</code>' : '') + '.</p>';
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
    else if (btn.dataset.osInstall) {
      var latest = state.os && state.os.latest;
      if (!latest) return;
      osAction('install', { sequence: latest.sequence, sha256: latest.sha256, request_id: requestId() }, {
        title: 'Install EpilykosOS ' + latest.version + '?',
        text: 'The appliance downloads and installs it into the other system slot while monitoring keeps running. Nothing changes until you restart.',
        label: 'Install' });
    }
    else if (btn.dataset.osCancel) osAction('cancel', { job: btn.dataset.osCancel });
    else if (btn.dataset.osRestart) osAction('restart', { job: btn.dataset.osRestart }, {
      title: 'Restart to finish the update?',
      text: 'Monitoring stops for a few minutes while the new system starts. If it doesn\u2019t start properly, the box goes back to this version by itself.',
      label: 'Restart' });
    else if (btn.dataset.osDiscard) osAction('discard', { job: btn.dataset.osDiscard }, {
      title: 'Discard the system update?', text: 'The box keeps running this version. You can install the update again later.', label: 'Discard' });
    else if (btn.dataset.osDismiss) osAction('dismiss', { job: btn.dataset.osDismiss });
  });

  root.addEventListener('change', function (ev) {
    if (ev.target.id === 'up-install-auto') {
      var on = ev.target.checked;
      ev.target.checked = !on; // the switch moves once the server agrees
      // Only turning it on needs the admin password.
      var password = on ? askPassword('Install updates automatically', 'Signed app releases will be installed without asking. Epilykos restarts during each one.', 'Turn on') : Promise.resolve('');
      password.then(function (pw) {
        if (pw === null) return;
        return api('POST', '/auto-install', { on: on, password: pw }).then(function (r) {
          state.autoInstall = r.autoInstall;
          render();
          toast(r.autoInstall ? 'Automatic installation enabled.' : 'Automatic installation disabled.');
        });
      }).catch(function (e) { toast(e.message, 'error'); });
      return;
    }
    if (ev.target.id !== 'up-auto') return;
    api('POST', '/auto', { on: ev.target.checked }).then(function (r) {
      state.auto = r.auto;
      toast(r.auto ? 'Daily check on.' : 'Daily check off.');
      load(); // automatic installation depends on it
    }, function (e) { toast(e.message, 'error'); ev.target.checked = !ev.target.checked; });
  });

  if (checkBtn) checkBtn.addEventListener('click', async function () {
    checkBtn.disabled = true;
    try {
      await api('POST', '/check', {});
      if (state && state.method && state.method.kind === 'epilykos-os') {
        await api('POST', '/os/check', {}).catch(function (e) { toast(e.message, 'error'); });
      }
      await load();
      toast(updateReady() ? 'An update is ready.' : (state.status && state.status.state === 'error') ? 'Could not check for updates.' : 'You are up to date.', state.status && state.status.state === 'error' ? 'error' : undefined);
    } catch (e) { toast(e.message, 'error'); }
    finally { checkBtn.disabled = false; }
  });

  load();
})();
