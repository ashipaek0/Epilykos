/**
 * Settings > Backup and restore > Remote backup (modules/cloudBackup): a folder or a WebDAV server.
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
  var settings = null, status = null, copies = null, copiesError = '', busy = false, formBusy = false;
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
    var d = s.destination, isDav = d.type === 'webdav';
    h += field('cb-dest', 'Where to send it', '<select class="input" id="cb-dest">' + opt('folder', 'Folder or drive on this box', d.type) + opt('webdav', 'WebDAV server', d.type) + '</select>');
    h += '<div id="cb-pane-folder"' + (isDav ? ' hidden' : '') + '>' + field('cb-path', 'Folder on this box', '<input class="input" id="cb-path" value="' + esc(isDav ? '' : d.path) + '" placeholder="/mnt/usb-backup/epilykos" autocomplete="off" spellcheck="false">',
      'A USB drive, or a network share you have mounted on the box. In Docker, a folder you mapped in as a volume. The drive must be mounted before the folder is created.') + '</div>';
    h += '<div id="cb-pane-webdav"' + (isDav ? '' : ' hidden') + '>'
      + '<div class="st-grid-2">'
      + field('cb-w-url', 'Server address', '<input class="input" id="cb-w-url" value="' + esc(isDav ? d.url : '') + '" placeholder="https://cloud.example.com/remote.php/dav/files/ade/" autocomplete="off" spellcheck="false">', 'Nextcloud, ownCloud, Synology and others. For Nextcloud, use the WebDAV address from its Files settings.')
      + field('cb-w-folder', 'Folder', '<input class="input" id="cb-w-folder" value="' + esc(isDav ? d.folder : 'Epilykos') + '" placeholder="Epilykos" autocomplete="off" spellcheck="false">', 'Created inside that address if it is missing.') + '</div>'
      + '<div class="st-grid-2">'
      + field('cb-w-user', 'Username', '<input class="input" id="cb-w-user" value="' + esc(isDav ? d.username : '') + '" autocomplete="off" spellcheck="false">')
      + field('cb-w-pass', isDav && d.hasPassword ? 'App password (saved)' : 'App password', '<input class="input" id="cb-w-pass" type="password" autocomplete="new-password">', isDav && d.hasPassword ? 'Leave empty to keep the saved password. Type one to change it.' : 'Make an app password for this box instead of using your main one.') + '</div>'
      + field('cb-w-fingerprint', 'Certificate fingerprint (optional)', '<input class="input" id="cb-w-fingerprint" value="' + esc(isDav ? d.fingerprint : '') + '" placeholder="AA:BB:CC:…" autocomplete="off" spellcheck="false">',
        'Only for a server with a certificate you made yourself. Paste its SHA-256 fingerprint and only that certificate is trusted. Leave empty for a normal https address.')
      + '</div>';
    h += '<div class="st-grid-2">'
      + field('cb-pass', s.hasPassphrase ? 'New passphrase (optional)' : 'Passphrase (required)', '<input class="input" id="cb-pass" type="password" autocomplete="new-password" minlength="8" maxlength="256">',
        s.hasPassphrase ? 'A passphrase is saved. Fill this in only to change it. Older copies keep the passphrase they were made with, until they are replaced.' : 'Locks the whole copy, history included, before it leaves the box. At least 8 characters. Epilykos cannot recover it, and you need it to restore.')
      + field('cb-pass2', 'Type it again', '<input class="input" id="cb-pass2" type="password" autocomplete="new-password" minlength="8" maxlength="256">') + '</div>';
    h += '<div class="st-grid-2">'
      + field('cb-schedule', 'How often', '<select class="input" id="cb-schedule">' + opt('weekly', 'Weekly', s.schedule) + opt('daily', 'Daily', s.schedule) + '</select>', 'Each upload is a full copy of your latest snapshot. Scheduled uploads start between 01:00 and 06:00.')
      + field('cb-keep', 'Copies to keep', '<select class="input" id="cb-keep">' + opt(1, '1', s.keep) + opt(2, '2', s.keep) + opt(4, '4', s.keep) + '</select>', 'The new copy is checked before an older one is deleted, so the destination briefly holds one more.') + '</div>';
    h += '</div>';
    h += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" id="cb-save" disabled>Save</button><button type="button" class="st-btn" id="cb-test">Test connection</button></div>';
    h += '<div id="cb-test-result" class="test-status" role="status"></div>';
    h += '<div id="cb-state"></div>';
    root.innerHTML = h;
    var markDirty = function () { $('cb-save').disabled = formBusy || !changed(); };
    $('cb-enabled').addEventListener('change', function () { $('cb-fields').hidden = !$('cb-enabled').checked; markDirty(); });
    ['cb-path', 'cb-pass', 'cb-pass2', 'cb-w-url', 'cb-w-folder', 'cb-w-user', 'cb-w-pass', 'cb-w-fingerprint'].forEach(function (id) { $(id).addEventListener('input', markDirty); });
    ['cb-schedule', 'cb-keep'].forEach(function (id) { $(id).addEventListener('change', markDirty); });
    $('cb-dest').addEventListener('change', function () { $('cb-pane-folder').hidden = $('cb-dest').value !== 'folder'; $('cb-pane-webdav').hidden = $('cb-dest').value !== 'webdav'; $('cb-test-result').textContent = ''; markDirty(); });
    $('cb-save').addEventListener('click', save);
    $('cb-test').addEventListener('click', testDestination);
    drawState();
  }
  function destinationDraft() {
    if ($('cb-dest').value === 'webdav') {
      return { type: 'webdav', url: $('cb-w-url').value.trim(), folder: $('cb-w-folder').value.trim(), username: $('cb-w-user').value, password: $('cb-w-pass').value, fingerprint: $('cb-w-fingerprint').value.trim() };
    }
    return { type: 'folder', path: $('cb-path').value.trim() };
  }
  function draft() {
    return { enabled: $('cb-enabled').checked, destination: destinationDraft(),
      schedule: $('cb-schedule').value, keep: Number($('cb-keep').value), passphrase: $('cb-pass').value };
  }
  function sameDestination(d, s) {
    if (d.type !== s.type) return false;
    if (d.type === 'folder') return d.path === s.path;
    return d.url === s.url && d.folder === s.folder && d.username === s.username && d.fingerprint === s.fingerprint && d.password === '';
  }
  function changed() {
    var d = draft(), s = settings;
    return d.enabled !== s.enabled || !sameDestination(d.destination, s.destination) || d.schedule !== s.schedule || d.keep !== s.keep || d.passphrase !== '' || $('cb-pass2').value !== '';
  }

  function confirmSaved() {
    var body = document.createElement('div');
    body.innerHTML = '<p>Without your passphrase, this backup cannot be opened by anyone, including us. Store it somewhere other than this box: a password manager or a printed page.</p>'
      + '<label class="st-check" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="cb-kept" required> I have saved my passphrase</label>';
    return window.stShell.openDialog({ title: 'Keep your passphrase safe', body: body, alert: true,
      actions: [{ label: 'Cancel', value: null }, { label: 'Start backing up', value: 'ok', kind: 'primary' }] }).then(function (r) { return r.value === 'ok'; });
  }

  function save() {
    var d = draft();
    if (d.passphrase !== $('cb-pass2').value) { tell('The two passphrases do not match.', 'error'); return; }
    if (d.enabled && !settings.hasPassphrase && !d.passphrase) { tell('Enter a passphrase first.', 'error'); return; }
    if (d.enabled && d.destination.type === 'folder' && !d.destination.path) { tell('Enter the folder to back up to.', 'error'); return; }
    if (d.enabled && d.destination.type === 'webdav' && (!d.destination.url || !d.destination.username)) { tell('Enter the server address and the username.', 'error'); return; }
    var proceed = d.passphrase ? confirmSaved() : Promise.resolve(true);
    proceed.then(function (ok) {
      if (!ok) return;
      formBusy = true; $('cb-save').disabled = true;
      var body = { enabled: d.enabled, destination: d.destination, schedule: d.schedule, keep: d.keep };
      if (d.passphrase) body.passphrase = d.passphrase;
      return api('/api/cloud-backup/settings', body).then(function (res) {
        settings = res.settings; status = res.status;
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
      out.textContent = (destination.type === 'webdav' ? 'The server accepted the sign-in and a test file.' : 'This folder works.') + (warnings.length ? ' ' + warnings.join(' ') : '');
    }).catch(function (e) { out.className = 'test-status error'; out.textContent = e.message; }).then(function () { button.disabled = false; });
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
    if (status.lastError) h += '<p class="st-help" style="color:var(--st-err)">' + esc(status.lastError) + (status.attempts ? ' It will try again automatically.' : '') + ' The previous copy stays in place.</p>';
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
    api('/api/cloud-backup/run', {}).then(function (r) { settings = r.settings; status = r.status; tell('Backup sent: ' + size(r.bytes) + '.'); })
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
    if (!settings.enabled && !(settings.destination.path || settings.destination.url)) { copies = []; drawState(); return Promise.resolve(); }
    return api('/api/cloud-backup/copies').then(function (r) { copies = r.copies; copiesError = ''; })
      .catch(function (e) { copies = []; copiesError = e.message; }).then(drawState);
  }
  function refresh(withCopies) {
    return api('/api/cloud-backup').then(function (r) { settings = r.settings; status = r.status; drawState(); return withCopies !== false ? loadCopies() : null; })
      .catch(function (e) { tell(e.message, 'error'); });
  }

  function load() {
    return api('/api/cloud-backup').then(function (r) { settings = r.settings; status = r.status; drawForm(); return loadCopies(); })
      .catch(function (e) { root.innerHTML = '<p class="st-help">Could not load: ' + esc(e.message) + '</p><button type="button" class="st-btn" id="cb-retry">Try again</button>'; $('cb-retry').addEventListener('click', load); });
  }
  load();
  // Keep the status current while the page is open and a backup may be running.
  setInterval(function () { if (!document.hidden && $('section-backup') && !$('section-backup').hidden && settings && !formBusy) refresh(false); }, 15000);
})();
