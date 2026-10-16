/**
 * Settings → Network → Remote access (Tailscale). Self-contained: talks to
 * /api/remote/tailscale and saves nothing through the save bar (the card has
 * data-own-save). Polls while the section is open: every 3 s while waiting on
 * the user (sign in, enable HTTPS), otherwise every 20 s.
 */
(function () {
  'use strict';

  var root = document.getElementById('rm-root');
  if (!root) return;
  var shell = window.stShell || {};
  var esc = shell.esc || function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }

  var st = null, open = false, timer = null, busy = false;

  function api(path, body) {
    var opts = { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/remote/tailscale' + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
        if (!res.ok) { var e = new Error(data.error || ('HTTP ' + res.status)); e.code = data.code; throw e; }
        return data;
      });
    });
  }

  function badge(text, tone) {
    var b = document.getElementById('rm-badge');
    if (!b) return;
    b.hidden = !text; b.textContent = text || '';
    b.className = 'st-badge' + (tone ? ' is-' + tone : '');
  }

  function waiting() { return st && (st.state === 'starting' || st.state === 'needs-login' || (st.state === 'running' && !st.serving && st.enableLink)); }

  function schedule() {
    clearTimeout(timer);
    if (!open || document.hidden) return;
    timer = setTimeout(function () { refresh().then(schedule); }, waiting() ? 3000 : 20000);
  }

  function refresh() {
    if (busy) return Promise.resolve();
    return api('').then(function (data) { st = data; render(); }).catch(function (e) {
      root.innerHTML = '<p class="st-help">Could not read remote access: ' + esc(e.message) + '</p>';
    });
  }

  function act(path, body, okMsg) {
    busy = true; render();
    return api(path, body).then(function (data) {
      st = data; busy = false; render();
      if (data.filledRemoteUrl) toast('Address away from home set to ' + data.privateUrl);
      else if (okMsg) toast(okMsg);
    }).catch(function (e) { busy = false; render(); toast(e.message, 'error'); throw e; }).then(schedule, schedule);
  }

  function copyButton(text) { return '<button type="button" class="st-btn rm-copy" data-copy="' + esc(text) + '">Copy</button>'; }

  function render() {
    if (!st) return;
    var h = '';
    var about = '<p class="st-help">Open your dashboard away from home without port forwarding or a reverse proxy. It uses <a href="https://tailscale.com" target="_blank" rel="noopener">Tailscale</a>, free for personal use: you sign in with Google, Apple, Microsoft or GitHub, and only your own devices can reach it unless you choose otherwise.</p>';
    var dis = busy ? ' disabled' : '';
    if (st.state === 'not-installed') {
      badge('');
      h = about + '<p class="st-help"><strong>Not included in this install.</strong> Update to the latest Epilykos image to use it.</p>';
    } else if (st.state === 'off') {
      badge('');
      h = about + '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" id="rm-connect"' + dis + '>' + (busy ? 'Starting…' : 'Connect with Tailscale') + '</button></div>';
    } else if (st.state === 'starting' || (st.state === 'needs-login' && !st.signInLink)) {
      badge('Starting');
      h = '<p class="st-help">Starting Tailscale…</p>' + offButton();
    } else if (st.state === 'needs-login') {
      badge('Sign in needed', 'warn');
      h = st.needsApproval
        ? '<p>Signed in. Approve this device in the <a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener">Tailscale admin console</a>, then come back.</p>'
        : '<p><strong>Sign in to Tailscale to finish.</strong> Open the link, or scan the code with your phone, and sign in with the account you want to use.</p>'
          + '<div class="rm-pair"><div class="rm-qr" aria-hidden="true">' + (st.signInQr || '') + '</div><div class="rm-pair-text">'
          + '<a class="st-btn st-btn-primary" href="' + esc(st.signInLink) + '" target="_blank" rel="noopener">Open sign-in page</a>'
          + '<p class="st-help">This page updates by itself once you have signed in.</p></div></div>';
      h += offButton();
    } else if (st.state === 'running') {
      var where = '<p class="st-help">Connected as <strong>' + esc(st.dnsName || 'this device') + '</strong>' + (st.tailnet ? ' on ' + esc(st.tailnet) : '') + (st.version ? ' · Tailscale ' + esc(st.version) : '') + '.</p>';
      if (!st.serving) {
        badge('Connected', 'ok');
        h = where;
        if (st.enableLink) {
          h += '<p><strong>Turn on HTTPS for your Tailscale network.</strong> Tailscale needs this once to give your dashboard a secure address.</p>'
            + '<div class="st-inline-actions"><a class="st-btn st-btn-primary" href="' + esc(st.enableLink) + '" target="_blank" rel="noopener">Turn on HTTPS</a></div>'
            + '<p class="st-help">This page updates by itself once it is on.</p>';
        } else {
          h += '<div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" id="rm-serve"' + dis + '>' + (busy ? 'Setting up…' : 'Create my address') + '</button></div>';
        }
        h += offButton();
      } else {
        badge(st.funnel ? 'Open to the internet' : 'Private', st.funnel ? 'warn' : 'ok');
        h = where
          + '<div class="rm-pair"><div class="rm-qr" aria-hidden="true">' + (st.urlQr || '') + '</div><div class="rm-pair-text">'
          + '<div class="rm-url"><a href="' + esc(st.privateUrl) + '" target="_blank" rel="noopener">' + esc(st.privateUrl) + '</a>' + copyButton(st.privateUrl) + '</div>'
          + '<p class="st-help">' + (st.funnel
            ? 'Anyone with this address can reach your sign-in page from any browser.'
            : 'Only devices signed in to your Tailscale account can open it. On your phone, install the Tailscale app and sign in with the same account.') + '</p></div></div>'
          + (st.funnel ? '<p class="rm-warn">Your dashboard is open to the internet. Keep your admin password long and private.</p>' : '')
          + '<div class="st-toggle-row"><span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="rm-funnel"' + (st.funnel ? ' checked' : '') + dis + (st.funnelAllowed || st.funnel ? '' : ' data-needs-enable="1"') + '><span class="slider"></span></label><label for="rm-funnel">Open to the internet</label></span></div>'
          + '<p class="st-help">Lets any browser open the address, without the Tailscale app. Off by default.</p>'
          + (st.enableLink ? '<p class="st-help"><a href="' + esc(st.enableLink) + '" target="_blank" rel="noopener">Allow it in Tailscale</a> first, then try again.</p>' : '')
          + offButton();
      }
    } else {
      badge('Stopped', 'warn');
      h = '<p class="st-help">Tailscale is stopped (' + esc(st.backendState || st.state) + ').</p><div class="st-inline-actions"><button type="button" class="st-btn" id="rm-connect"' + dis + '>Connect again</button></div>' + offButton();
    }
    if (st.error && st.state === 'starting') h += '<p class="st-help">' + esc(st.error) + '</p>';
    root.innerHTML = h;
  }

  function offButton() {
    return '<div class="st-inline-actions rm-off"><button type="button" class="st-btn st-btn-danger-text" id="rm-disconnect"' + (busy ? ' disabled' : '') + '>Turn off remote access</button></div>';
  }

  function askPassword() {
    var body = document.createElement('div');
    body.innerHTML = '<p>Anyone on the internet will be able to reach your sign-in page and try passwords. Your admin password must be at least 12 characters.</p>'
      + '<div class="st-field"><label for="rm-pw">Admin password</label><input id="rm-pw" class="input" type="password" autocomplete="current-password" required></div>';
    var input = body.querySelector('input');
    setTimeout(function () { input.focus(); }, 50);
    return shell.openDialog({ title: 'Open your dashboard to the internet?', body: body, actions: [{ label: 'Cancel', value: null }, { label: 'Open to the internet', value: 'ok', kind: 'danger' }] })
      .then(function (r) { return r && r.value === 'ok' ? input.value : null; });
  }

  root.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.id === 'rm-connect') act('/connect', {}).catch(function () {});
    else if (t.id === 'rm-serve') act('/serve', {}).catch(function () {});
    else if (t.id === 'rm-disconnect') {
      var ask = window.stConfirm ? window.stConfirm({ title: 'Turn off remote access?', message: 'This device leaves your Tailscale network, and its remote address stops working.', confirmLabel: 'Turn off' }) : Promise.resolve(true);
      Promise.resolve(ask).then(function (yes) { if (yes) act('/disconnect', {}, 'Remote access turned off').catch(function () {}); });
    } else if (t.classList.contains('rm-copy')) {
      var text = t.dataset.copy;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Copied'); }, function () { toast(text); });
    }
  });

  root.addEventListener('change', function (e) {
    if (e.target.id !== 'rm-funnel') return;
    var box = e.target, on = box.checked;
    box.checked = !on;   // stays as it was until the server agrees
    if (!on) { act('/funnel', { on: false }, 'Closed to the internet').catch(function () {}); return; }
    askPassword().then(function (pw) {
      if (pw === null) return;
      return act('/funnel', { on: true, password: pw }, 'Open to the internet').catch(function () {});
    });
  });

  document.addEventListener('visibilitychange', function () { if (!document.hidden && open) refresh().then(schedule); else clearTimeout(timer); });
  document.addEventListener('st:section-shown', function (ev) {
    open = ev.detail && ev.detail.section === 'network';
    if (open) refresh().then(schedule); else clearTimeout(timer);
  });
})();
