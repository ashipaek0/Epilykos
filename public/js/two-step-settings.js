/**
 * Settings → Security → Two-step sign-in. Self-contained: talks to
 * /api/two-step and saves nothing through the save bar (the card has
 * data-own-save). Loaded after settings-shell.js.
 *
 * On:  password → QR code and a code from the app → recovery codes, once.
 * Off: password and a current code. New recovery codes: the same.
 */
(function () {
  'use strict';

  var root = document.getElementById('ts-root');
  if (!root) return;
  var shell = window.stShell || {};
  var esc = shell.esc || function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }

  var status = null;

  function api(path, body) {
    var opts = { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/two-step' + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
        if (!res.ok) { var e = new Error(data.error || ('HTTP ' + res.status)); e.serverTime = data.serverTime; throw e; }
        return data;
      });
    });
  }

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  function field(id, label, attrs) {
    var wrap = el('div', { class: 'st-field' });
    wrap.appendChild(el('label', { for: id }, esc(label)));
    var input = el('input', Object.assign({ id: id, name: id, class: 'input', autocomplete: 'off', required: '' }, attrs || {}));
    wrap.appendChild(input);
    return wrap;
  }

  function errorLine(message, serverTime) {
    var p = el('p', { class: 'st-help', role: 'alert', style: 'color: var(--danger, #dc6b4a);' });
    if (!message) { p.hidden = true; return p; }
    p.textContent = message + (serverTime ? ' This box thinks it is ' + new Date(serverTime).toLocaleString() + '.' : '');
    return p;
  }

  // Ask in a dialog; `submit(values)` runs on Continue and may throw to show
  // its message and ask again. Resolves with submit's result, or null on Cancel.
  function ask(opts) {
    function round(message, serverTime) {
      var body = document.createElement('div');
      body.appendChild(errorLine(message, serverTime));
      opts.build(body);
      return shell.openDialog({
        title: opts.title,
        body: body,
        actions: [{ label: 'Cancel', value: null }, { label: opts.label || 'Continue', value: 'ok', kind: 'primary' }]
      }).then(function (r) {
        if (r.value !== 'ok') return null;
        return Promise.resolve().then(function () { return opts.submit(r.form.elements); })
          .catch(function (e) { return round(e.message, e.serverTime); });
      });
    }
    return round('');
  }

  function showRecoveryCodes(codes, title) {
    var text = codes.join('\n');
    var body = document.createElement('div');
    body.appendChild(el('p', {}, 'Keep these somewhere safe, apart from your phone. Each one signs you in once if you lose the app. They are shown only now.'));
    var list = el('pre', { class: 'st-code', 'aria-label': 'Recovery codes', style: 'user-select: all; font-size: 1.05rem; line-height: 1.6;' });
    list.textContent = text;
    body.appendChild(list);
    var row = el('div', { class: 'st-inline-actions' });
    var copy = el('button', { type: 'button', class: 'st-btn' }, 'Copy');
    copy.addEventListener('click', function () {
      var done = function () { toast('Recovery codes copied'); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { toast('Select the codes and copy them by hand', 'error'); });
      else { var sel = window.getSelection(); var range = document.createRange(); range.selectNodeContents(list); sel.removeAllRanges(); sel.addRange(range); toast('Selected: press Copy on your keyboard'); }
    });
    var save = el('button', { type: 'button', class: 'st-btn' }, 'Download .txt');
    save.addEventListener('click', function () {
      var blob = new Blob(['Epilykos recovery codes\n' + new Date().toLocaleDateString() + '\nEach code works once.\n\n' + text + '\n'], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'epilykos-recovery-codes.txt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    row.appendChild(copy); row.appendChild(save);
    body.appendChild(row);
    var confirm = el('label', { class: 'st-check-card' });
    confirm.innerHTML = '<input type="checkbox" name="saved" required><span><span class="st-choice-title">I have saved these codes</span></span>';
    body.appendChild(confirm);
    return shell.openDialog({ title: title, body: body, alert: true, actions: [{ label: 'Done', value: 'ok', kind: 'primary' }] });
  }

  // Turning it on.
  function turnOn() {
    return ask({
      title: 'Turn on two-step sign-in',
      build: function (body) {
        body.appendChild(el('p', {}, 'After your password, sign-in will ask for a 6-digit code from an authenticator app on your phone. Enter your dashboard password to start.'));
        body.appendChild(field('ts-password', 'Dashboard password', { type: 'password' }));
      },
      submit: function (f) { return api('/begin', { password: f['ts-password'].value }); }
    }).then(function (setup) {
      if (!setup) return false;
      return ask({
        title: 'Scan with your authenticator app',
        label: 'Turn on',
        build: function (body) {
          body.appendChild(el('p', {}, 'Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others), add an account, and scan this code.'));
          var img = el('img', { alt: 'QR code for your authenticator app', width: '240', height: '240', style: 'display:block; margin: 8px auto; background: #fff; border-radius: 6px;' });
          img.src = setup.qr;
          body.appendChild(img);
          body.appendChild(el('p', { class: 'st-help' }, 'Cannot scan? Enter this key instead: <code style="user-select: all; word-break: break-all;">' + esc(setup.secret) + '</code>'));
          body.appendChild(field('ts-code', 'Then enter the 6-digit code it shows', { type: 'text', inputmode: 'numeric', maxlength: '7', pattern: '[0-9 ]{6,7}' }));
        },
        submit: function (f) { return api('/enable', { code: f['ts-code'].value }); }
      });
    }).then(function (done) {
      if (!done) return false;
      return showRecoveryCodes(done.recoveryCodes, 'Save your recovery codes').then(function () {
        toast('Two-step sign-in is on');
        return true;
      });
    });
  }

  function disable() {
    return ask({
      title: 'Turn off two-step sign-in',
      label: 'Turn off',
      build: function (body) {
        body.appendChild(el('p', {}, 'Enter your password and a current code to confirm it is you. Sign-in goes back to the password alone.'));
        body.appendChild(field('ts-password', 'Dashboard password', { type: 'password' }));
        body.appendChild(field('ts-code', 'Code from the app, or a recovery code', { type: 'text', autocapitalize: 'characters' }));
      },
      submit: function (f) { return api('/disable', { password: f['ts-password'].value, code: f['ts-code'].value }); }
    }).then(function (done) {
      if (done) toast('Two-step sign-in is off');
      return !!done;
    });
  }

  function newCodes() {
    return ask({
      title: 'New recovery codes',
      label: 'Make new codes',
      build: function (body) {
        body.appendChild(el('p', {}, 'This replaces all your recovery codes. Enter your password and a current code.'));
        body.appendChild(field('ts-password', 'Dashboard password', { type: 'password' }));
        body.appendChild(field('ts-code', 'Code from the app, or a recovery code', { type: 'text', autocapitalize: 'characters' }));
      },
      submit: function (f) { return api('/recovery', { password: f['ts-password'].value, code: f['ts-code'].value }); }
    }).then(function (done) {
      if (!done) return false;
      return showRecoveryCodes(done.recoveryCodes, 'Your new recovery codes').then(function () { return true; });
    });
  }

  function render() {
    var s = status;
    var detail;
    if (s.broken) detail = '<p class="st-help" style="color: var(--danger, #dc6b4a);">Two-step sign-in is on, but its settings file is damaged, so nobody can sign in. Reset it with the password reset (see the README), then turn it on again.</p>';
    else if (s.enabled) {
      detail = '<p class="st-help">Signing in asks for your password, then a code from your authenticator app. <strong>' + s.recoveryLeft + '</strong> recovery code' + (s.recoveryLeft === 1 ? '' : 's') + ' left.</p>' +
        (s.recoveryLeft <= 2 ? '<p class="st-help" style="color: var(--danger, #dc6b4a);">You are nearly out of recovery codes. Make new ones.</p>' : '') +
        '<div class="st-inline-actions"><button type="button" class="st-btn" id="ts-new-codes">New recovery codes…</button></div>';
    } else detail = '<p class="st-help">Add a code from an authenticator app after your password. Works without internet; if you lose the phone, the recovery codes or the password reset on the box (or <code>RESET_TWO_STEP</code> with Docker) let you back in.</p>';
    root.innerHTML =
      '<div class="st-toggle-row"><span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="ts-toggle"' + (s.enabled ? ' checked' : '') + '><span class="slider"></span></label><label for="ts-toggle">Two-step sign-in</label></span></div>' +
      (s.resetByEnv ? '<p class="st-help">RESET_TWO_STEP is set for this container, so two-step sign-in is switched off at every start. Remove it to use two-step sign-in.</p>' : '') +
      detail;
    var badge = document.getElementById('ts-badge');
    if (badge) { badge.hidden = false; badge.textContent = s.broken ? 'Damaged' : s.enabled ? 'On' : 'Off'; badge.className = 'st-badge' + (s.broken ? ' is-warn' : s.enabled ? ' is-ok' : ''); }
    var toggle = document.getElementById('ts-toggle');
    toggle.addEventListener('change', function () {
      var want = toggle.checked;
      toggle.disabled = true;
      (want ? turnOn() : disable()).then(load, function (e) { toast(e.message, 'error'); return load(); });
    });
    var more = document.getElementById('ts-new-codes');
    if (more) more.addEventListener('click', function () { newCodes().then(load, function (e) { toast(e.message, 'error'); }); });
  }

  function load() {
    return api('/status').then(function (s) { status = s; render(); }, function (e) {
      root.innerHTML = '<p class="st-help">Could not load: ' + esc(e.message) + '</p>';
    });
  }

  document.addEventListener('st:section-shown', function (ev) { if (ev.detail && ev.detail.section === 'security') load(); });
  if (location.hash === '#security') load();
})();
