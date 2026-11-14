/**
 * Settings > Backup and restore > Remote backup (modules/cloudBackup): a folder, a WebDAV server or Google Drive.
 *
 * One way to save, like the Prepaid meter page: the switch, the folder, the
 * schedule, the copies to keep and the passphrase are a draft until Save is
 * pressed. Saving a new passphrase first asks you to confirm you have kept it.
 * Back up now, Check copy and Restore are actions and happen when pressed.
 * Feedback is the page's toast.
 */
(function () {
  'use strict';
  var root = document.getElementById('cb-root');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var settings = null, status = null, google = { available: false, connected: false }, flow = null, copies = null, copiesError = '', busy = false, formBusy = false;
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) } : { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || ('Server error ' + r.status)); e.data = d; throw e; } return d; }); });
  }
  function tell(msg, tone) { if (window.stShell && window.stShell.toast) window.stShell.toast(msg, tone ? { tone: tone } : {}); }
  function size(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB'; }
  function when(iso) { return iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'; }

  // ── The settings form: drawn once from the saved settings ──
  function field(id, label, input, help) { return '<div class="st-field"><label for="' + id + '">' + label + '</label>' + input + (help ? '<span class="st-help">' + help + '</span>' : '') + '</div>'; }
  function opt(value, text, current) { return '<option value="' + value + '"' + (String(current) === String(value) ? ' selected' : '') + '>' + text + '</option>'; }
  function drawForm() {
    var s = settings;
    var h = '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="cb-enabled"' + (s.enabled ? ' checked' : '') + '><span class="slider"></span></label><label for="cb-enabled">Back up off this box</label></span>';
    h += '<div id="cb-fields"' + (s.enabled ? '' : ' hidden') + '>';
    var d = s.destination, isDav = d.type === 'webdav', isG = d.type === 'gdrive';
    h += field('cb-dest', 'Where to send it', '<select class="input" id="cb-dest">' + opt('folder', 'Folder or drive on this box', d.type) + opt('webdav', 'WebDAV server', d.type) + opt('gdrive', 'Google Drive', d.type) + '</select>');
    h += '<div id="cb-pane-folder"' + (d.type === 'folder' ? '' : ' hidden') + '>' + field('cb-path', 'Folder on this box', '<input class="input" id="cb-path" value="' + esc(isDav ? '' : d.path) + '" placeholder="/mnt/usb-backup/epilykos" autocomplete="off" spellcheck="false">',
      'A mounted USB drive, network share or Docker volume.') + '</div>';
    h += '<div id="cb-pane-webdav"' + (isDav ? '' : ' hidden') + '>'
      + '<div class="st-grid-2">'
      + field('cb-w-url', 'Server address', '<input class="input" id="cb-w-url" value="' + esc(isDav ? d.url : '') + '" placeholder="https://cloud.example.com/remote.php/dav/files/ade/" autocomplete="off" spellcheck="false">', 'Nextcloud, ownCloud, Synology and others.')
      + field('cb-w-folder', 'Folder', '<input class="input" id="cb-w-folder" value="' + esc(isDav ? d.folder : 'Epilykos') + '" placeholder="Epilykos" autocomplete="off" spellcheck="false">', 'Created inside that address if it is missing.') + '</div>'
      + '<div class="st-grid-2">'
      + field('cb-w-user', 'Username', '<input class="input" id="cb-w-user" value="' + esc(isDav ? d.username : '') + '" autocomplete="off" spellcheck="false">')
      + field('cb-w-pass', isDav && d.hasPassword ? 'App password (saved)' : 'App password', '<input class="input" id="cb-w-pass" type="password" autocomplete="new-password">', isDav && d.hasPassword ? 'Leave empty to keep the saved password. Type one to change it.' : 'Make an app password for this box instead of using your main one.') + '</div>'
      + field('cb-w-cert', 'Server certificate (optional)', '<textarea class="input" id="cb-w-cert" rows="4" placeholder="-----BEGIN CERTIFICATE-----" autocomplete="off" spellcheck="false">' + esc(isDav ? d.certificate : '') + '</textarea>',
        'Only for a server with its own certificate. Leave empty for a normal https address.')
      + '</div>';
    h += '<div id="cb-pane-gdrive"' + (isG ? '' : ' hidden') + '></div>';
    h += '<div class="st-grid-2">'
      + field('cb-pass', s.hasPassphrase ? 'New passphrase (optional)' : 'Passphrase (required)', '<input class="input" id="cb-pass" type="password" autocomplete="new-password" minlength="8" maxlength="256">',
        s.hasPassphrase ? 'A passphrase is saved. Fill this in only to change it.' : 'At least 8 characters. Epilykos cannot recover it.')
      + field('cb-pass2', 'Type it again', '<input class="input" id="cb-pass2" type="password" autocomplete="new-password" minlength="8" maxlength="256">') + '</div>';
    h += '<div class="st-grid-2">'
      + field('cb-schedule', 'How often', '<select class="input" id="cb-schedule">' + opt('weekly', 'Weekly', s.schedule) + opt('daily', 'Daily', s.schedule) + '</select>', 'Runs between 01:00 and 06:00.')
      + field('cb-keep', 'Copies to keep', '<select class="input" id="cb-keep">' + opt(1, '1', s.keep) + opt(2, '2', s.keep) + opt(4, '4', s.keep) + '</select>', 'Older copies are deleted after the new one is checked.') + '</div>';
    h += '</div>';
    h += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" id="cb-save" disabled>Save</button><button type="button" class="st-btn" id="cb-test">Test connection</button></div>';
    h += '<div id="cb-test-result" class="test-status" role="status"></div>';
    h += '<div id="cb-state"></div>';
    root.innerHTML = h;
    var markDirty = function () { $('cb-save').disabled = formBusy || !changed(); };
    $('cb-enabled').addEventListener('change', function () { $('cb-fields').hidden = !$('cb-enabled').checked; markDirty(); });
    ['cb-path', 'cb-pass', 'cb-pass2', 'cb-w-url', 'cb-w-folder', 'cb-w-user', 'cb-w-pass', 'cb-w-cert'].forEach(function (id) { $(id).addEventListener('input', markDirty); });
    ['cb-schedule', 'cb-keep'].forEach(function (id) { $(id).addEventListener('change', markDirty); });
    $('cb-dest').addEventListener('change', function () { ['folder', 'webdav', 'gdrive'].forEach(function (k) { $('cb-pane-' + k).hidden = $('cb-dest').value !== k; }); $('cb-test-result').textContent = ''; markDirty(); });
    drawGoogle();
    $('cb-save').addEventListener('click', save);
    $('cb-test').addEventListener('click', testDestination);
    drawState();
  }
  function destinationDraft() {
    if ($('cb-dest').value === 'gdrive') return { type: 'gdrive' };
    if ($('cb-dest').value === 'webdav') {
      return { type: 'webdav', url: $('cb-w-url').value.trim(), folder: $('cb-w-folder').value.trim(), username: $('cb-w-user').value, password: $('cb-w-pass').value, certificate: $('cb-w-cert').value.trim() };
    }
    return { type: 'folder', path: $('cb-path').value.trim() };
  }
  function draft() {
    return { enabled: $('cb-enabled').checked, destination: destinationDraft(),
      schedule: $('cb-schedule').value, keep: Number($('cb-keep').value), passphrase: $('cb-pass').value };
  }
  function sameDestination(d, s) {
    if (d.type !== s.type) return false;
    if (d.type === 'gdrive') return true;
    if (d.type === 'folder') return d.path === s.path;
    return d.url === s.url && d.folder === s.folder && d.username === s.username && d.certificate === s.certificate && d.password === '';
  }
  function changed() {
    var d = draft(), s = settings;
    return d.enabled !== s.enabled || !sameDestination(d.destination, s.destination) || d.schedule !== s.schedule || d.keep !== s.keep || d.passphrase !== '' || $('cb-pass2').value !== '';
  }

  function confirmSaved() {
    var body = document.createElement('div');
    body.innerHTML = '<p>Without this passphrase nobody can open the backup. Keep it off this box, in a password manager or on paper.</p>'
      + '<label class="st-check" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="cb-kept" required> I have saved my passphrase</label>';
    return window.stShell.openDialog({ title: 'Keep your passphrase safe', body: body, alert: true,
      actions: [{ label: 'Cancel', value: null }, { label: 'Start backing up', value: 'ok', kind: 'primary' }] }).then(function (r) { return r.value === 'ok'; });
  }

  function save() {
    var d = draft();
    if (d.passphrase !== $('cb-pass2').value) { tell('The two passphrases do not match.', 'error'); return; }
    if (d.enabled && !settings.hasPassphrase && !d.passphrase) { tell('Enter a passphrase first.', 'error'); return; }
    if (d.enabled && d.destination.type === 'folder' && !d.destination.path) { tell('Enter the folder to back up to.', 'error'); return; }
    if (d.enabled && d.destination.type === 'gdrive' && !google.connected) { tell('Connect Google Drive first.', 'error'); return; }
    if (d.enabled && d.destination.type === 'webdav' && (!d.destination.url || !d.destination.username)) { tell('Enter the server address and the username.', 'error'); return; }
    var proceed = d.passphrase ? confirmSaved() : Promise.resolve(true);
    proceed.then(function (ok) {
      if (!ok) return;
      formBusy = true; $('cb-save').disabled = true;
      var body = { enabled: d.enabled, destination: d.destination, schedule: d.schedule, keep: d.keep };
      if (d.passphrase) body.passphrase = d.passphrase;
      return api('/api/cloud-backup/settings', body).then(function (res) {
        settings = res.settings; status = res.status; google = res.google || google;
        tell(d.enabled ? 'Remote backup saved. The first copy is sent shortly.' : 'Remote backup switched off.');
        formBusy = false; drawForm(); loadCopies();
      });
    }).catch(function (e) { tell(e.message, 'error'); }).then(function () { formBusy = false; if ($('cb-save')) $('cb-save').disabled = !changed(); });
  }

  function testDestination() {
    var out = $('cb-test-result'), button = $('cb-test'), destination = destinationDraft();
    out.className = 'test-status'; out.textContent = 'Testing…'; button.disabled = true;
    api('/api/cloud-backup/test', { destination: destination }).then(function (r) {
      var warnings = r.warnings || [];
      out.className = warnings.length ? 'test-status' : 'test-status success';
      out.textContent = (destination.type === 'webdav' ? 'The server accepted the sign-in and a test file.' : destination.type === 'gdrive' ? 'Google Drive accepted a test file.' : 'This folder works.') + (warnings.length ? ' ' + warnings.join(' ') : '');
    }).catch(function (e) { out.className = 'test-status error'; out.textContent = e.message; }).then(function () { button.disabled = false; });
  }

  // ── Google Drive: connecting from a box with no browser ──
  function drawGoogle() {
    var el = $('cb-pane-gdrive'); if (!el) return;
    var h;
    if (!google.available) h = '<p class="st-help">Google Drive is not set up in this build of Epilykos.</p>';
    else if (google.connected) h = '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">Connected to Google Drive</span><div class="st-help">Backups go in an Epilykos folder in your Drive.</div></div><button type="button" class="st-btn" id="cb-g-disconnect">Disconnect</button></div>';
    else h = '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">Not connected</span><div class="st-help">Epilykos can only see the files it creates.</div></div><button type="button" class="st-btn st-btn-primary" id="cb-g-connect">Connect Google Drive…</button></div>';
    h += '<div id="cb-g-flow"></div>';
    el.innerHTML = h;
    var c = $('cb-g-connect'); if (c) c.addEventListener('click', googleConnect);
    var x = $('cb-g-disconnect'); if (x) x.addEventListener('click', googleDisconnect);
    drawFlow();
  }
  function drawFlow() {
    var el = $('cb-g-flow'); if (!el) return;
    if (!flow) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="st-field"><p class="st-help">Open this address on any device and enter the code.</p>'
      + '<p><a class="help-link" href="' + esc(flow.verificationUrl) + '" target="_blank" rel="noopener">' + esc(flow.verificationUrl) + '</a></p>'
      + '<p style="font:600 1.4rem ui-monospace,Menlo,monospace;letter-spacing:.08em;margin:.3rem 0">' + esc(flow.userCode) + '</p>'
      + '<p class="st-help" id="cb-g-wait">Waiting for you to approve…</p><div><button type="button" class="st-btn" id="cb-g-cancel">Cancel</button></div></div>';
    $('cb-g-cancel').addEventListener('click', function () { stopFlow(); api('/api/cloud-backup/google/cancel', {}).catch(function () {}); });
  }
  function stopFlow() { if (flow && flow.timer) clearTimeout(flow.timer); flow = null; drawFlow(); }
  function googleConnect() {
    var button = $('cb-g-connect'); if (button) button.disabled = true;
    api('/api/cloud-backup/google/start', {}).then(function (r) {
      flow = { userCode: r.userCode, verificationUrl: r.verificationUrl, interval: r.interval, deadline: Date.now() + r.expiresIn * 1000, timer: null };
      drawFlow(); pollFlow();
    }).catch(function (e) { tell(e.message, 'error'); if (button) button.disabled = false; });
  }
  function pollFlow() {
    if (!flow) return;
    flow.timer = setTimeout(function () {
      if (!flow) return;
      api('/api/cloud-backup/google/poll').then(function (r) {
        if (!flow) return;
        if (r.status === 'pending') { flow.interval = r.interval || flow.interval; return pollFlow(); }
        stopFlow();
        if (r.status === 'connected') {
          settings = r.overview.settings; status = r.overview.status; google = r.overview.google;
          tell('Google Drive connected.'); drawGoogle(); loadCopies();
          if ($('cb-save')) $('cb-save').disabled = !changed();
        } else tell(r.status === 'denied' ? 'Google Drive access was not approved.' : 'The code ran out. Press Connect Google Drive to try again.', 'error');
        drawGoogle();
      }).catch(function (e) { stopFlow(); tell(e.message, 'error'); drawGoogle(); });
    }, Math.max(2, flow.interval) * 1000);
  }
  function googleDisconnect() {
    window.stShell.openDialog({ title: 'Disconnect Google Drive?', alert: true,
      body: '<p>Google Drive backup switches off. Copies already in your Drive stay there.</p>',
      actions: [{ label: 'Cancel', value: null }, { label: 'Disconnect', value: 'ok', kind: 'danger' }] }).then(function (r) {
      if (r.value !== 'ok') return;
      return api('/api/cloud-backup/google/disconnect', {}).then(function (o) {
        settings = o.settings; status = o.status; google = o.google; tell('Google Drive disconnected.');
        drawForm(); loadCopies();
      }).catch(function (e) { tell(e.message, 'error'); });
    });
  }

  // ── Status, the copies, and the actions: redrawn without touching the form ──
  function pill() {
    if (!status.enabled) return '<span class="st-pill is-off"><span class="st-pill-dot"></span>Off</span>';
    if (status.running) return '<span class="st-pill is-new"><span class="st-pill-dot"></span>Working: ' + esc(status.phase) + '</span>';
    if (status.lastError) return '<span class="st-pill is-error"><span class="st-pill-dot"></span>Last upload failed</span>';
    if (status.overdue) return '<span class="st-pill is-error"><span class="st-pill-dot"></span>Overdue</span>';
    if (!status.lastOkAt) return '<span class="st-pill is-unknown"><span class="st-pill-dot"></span>Waiting for the first copy</span>';
    return '<span class="st-pill is-ok"><span class="st-pill-dot"></span>Up to date</span>';
  }
  function drawState() {
    var el = $('cb-state'); if (!el) return;
    if (!settings.enabled && !status.lastOkAt && !(copies && copies.length)) { el.innerHTML = ''; return; }
    var h = '<hr style="border:0;border-top:1px solid var(--st-line-soft);width:100%;margin:4px 0">' + '<div class="st-inline-actions" style="justify-content:space-between">' + pill() + '</div>';
    h += '<p class="st-help">' + (status.lastOkAt ? 'Last copy sent <b>' + esc(when(status.lastOkAt)) + '</b> (' + esc(size(status.lastBytes || 0)) + ').' : 'No copy has been sent yet.')
      + (status.enabled && status.nextAt && !status.running ? ' Next: <b>' + esc(when(status.nextAt)) + '</b>.' : '') + '</p>';
    if (status.lastError) h += '<p class="st-help" style="color:var(--st-err)">' + esc(status.lastError) + (status.attempts ? ' Retrying.' : '') + '</p>';
    h += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" id="cb-run"' + (!status.enabled || status.running || busy ? ' disabled' : '') + '>Back up now</button>'
      + '<button type="button" class="st-btn" id="cb-refresh">Refresh</button></div>';
    h += '<div id="cb-copies" class="st-snapshots">';
    if (copiesError) h += '<p class="st-help" style="color:var(--st-err)">' + esc(copiesError) + '</p>';
    else if (copies === null) h += '<p class="st-help">Loading copies…</p>';
    else if (!copies.length) h += '<p class="st-help">No copies at the destination yet.</p>';
    else h += copies.map(function (c) {
      return '<div class="st-snapshot"><div style="min-width:0"><span class="st-snapshot-date">' + esc(when(c.time)) + '</span> <span class="st-help">· ' + esc(size(c.size)) + ' · Encrypted</span></div>'
        + '<span class="st-inline-actions"><button type="button" class="st-btn" data-check="' + esc(c.name) + '">Check copy</button><button type="button" class="st-btn" data-restore="' + esc(c.name) + '">Restore…</button></span></div>';
    }).join('');
    h += '</div>';
    el.innerHTML = h;
    var run = $('cb-run'); if (run) run.addEventListener('click', runNow);
    $('cb-refresh').addEventListener('click', function () { refresh(true); });
    el.querySelectorAll('[data-check]').forEach(function (b) { b.addEventListener('click', function () { checkCopy(b.getAttribute('data-check'), b); }); });
    el.querySelectorAll('[data-restore]').forEach(function (b) { b.addEventListener('click', function () { restoreCopy(b.getAttribute('data-restore')); }); });
  }

  function runNow() {
    busy = true; status.running = true; status.phase = 'starting'; drawState();
    api('/api/cloud-backup/run', {}).then(function (r) { settings = r.settings; status = r.status; google = r.google || google; tell('Backup sent: ' + size(r.bytes) + '.'); })
      .catch(function (e) { if (e.data && e.data.status) status = e.data.status; tell('Backup failed: ' + e.message, 'error'); })
      .then(function () { busy = false; return refresh(true); });
  }
  function checkCopy(name, button) {
    button.disabled = true;
    api('/api/cloud-backup/copies/' + encodeURIComponent(name) + '/check', {}).then(function () { tell('This copy opens with your passphrase and is intact at the start.'); })
      .catch(function (e) { tell(e.message, 'error'); }).then(function () { button.disabled = false; });
  }
  function restoreCopy(name) {
    var body = document.createElement('div');
    body.innerHTML = '<p>This replaces everything on this box with what is in that copy.</p>'
      + '<div class="st-field"><label for="cb-restore-pass">Passphrase for this copy (leave empty to use the saved one)</label><input class="input" id="cb-restore-pass" type="password" autocomplete="off"></div>';
    window.stShell.openDialog({ title: 'Restore this copy?', body: body, alert: true, actions: [{ label: 'Cancel', value: null }, { label: 'Restore', value: 'ok', kind: 'danger' }] }).then(function (r) {
      if (r.value !== 'ok') return;
      var pass = ($('cb-restore-pass') || {}).value || '';
      tell('Restoring… this can take a few minutes.');
      return api('/api/cloud-backup/copies/' + encodeURIComponent(name) + '/restore', pass ? { passphrase: pass } : {})
        .then(function () { tell('Restored. Reloading…'); setTimeout(function () { location.reload(); }, 1500); })
        .catch(function (e) { tell('Restore failed: ' + e.message, 'error'); });
    });
  }

  function loadCopies() {
    if (!settings.enabled && !(settings.destination.path || settings.destination.url || google.connected)) { copies = []; drawState(); return Promise.resolve(); }
    return api('/api/cloud-backup/copies').then(function (r) { copies = r.copies; copiesError = ''; })
      .catch(function (e) { copies = []; copiesError = e.message; }).then(drawState);
  }
  function refresh(withCopies) {
    return api('/api/cloud-backup').then(function (r) { settings = r.settings; status = r.status; google = r.google || google; drawState(); return withCopies !== false ? loadCopies() : null; })
      .catch(function (e) { tell(e.message, 'error'); });
  }

  function load() {
    return api('/api/cloud-backup').then(function (r) { settings = r.settings; status = r.status; google = r.google || google; drawForm(); return loadCopies(); })
      .catch(function (e) { root.innerHTML = '<p class="st-help">Could not load: ' + esc(e.message) + '</p><button type="button" class="st-btn" id="cb-retry">Try again</button>'; $('cb-retry').addEventListener('click', load); });
  }
  load();
  // Keep the status current while the page is open and a backup may be running.
  setInterval(function () { if (!document.hidden && $('section-backup') && !$('section-backup').hidden && settings && !formBusy) refresh(false); }, 15000);
})();
