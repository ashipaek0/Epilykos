/**
 * "Get notifications on this device?" — a small toast any browser can accept,
 * signed in or not. Accepting registers the browser with the server as a
 * possible push target (POST /api/push/register). It receives nothing until the
 * admin picks it for a rule in Settings → Notifications.
 *
 * Shown only where push can work (HTTPS, service worker, push support), not
 * when the browser has blocked notifications for this site, and not for a week
 * after "Not now". A browser the server does not know (never registered, or
 * removed by the admin) is offered the toast again.
 */
(function () {
  'use strict';

  var DISMISS_KEY = 'epilykos_push_prompt_until';
  var DISMISS_MS = 7 * 24 * 3600 * 1000;
  var DELAY_MS = 4000;

  function supported() {
    return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function dismissedUntil() {
    try { return Number(localStorage.getItem(DISMISS_KEY)) || 0; } catch (e) { return 0; }
  }
  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_MS)); } catch (e) { /* private mode */ }
  }

  function sha256Hex(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function keyBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); });
  }

  function css() {
    if (document.getElementById('push-prompt-css')) return;
    var s = document.createElement('style');
    s.id = 'push-prompt-css';
    s.textContent =
      '.push-prompt{position:fixed;right:16px;bottom:16px;z-index:10000;max-width:min(360px,calc(100vw - 32px));padding:14px 16px;border-radius:12px;' +
      'background:var(--card-bg,#fff);color:var(--text-primary,#1c1917);border:1px solid var(--border,rgba(0,0,0,.15));box-shadow:0 8px 28px rgba(0,0,0,.22);font:14px/1.4 inherit}' +
      '.push-prompt p{margin:0 0 10px}.push-prompt strong{display:block;margin-bottom:2px}' +
      '.push-prompt .push-prompt-actions{display:flex;gap:8px;justify-content:flex-end}' +
      '.push-prompt button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--border,rgba(0,0,0,.2));background:transparent;color:inherit;cursor:pointer}' +
      '.push-prompt button.push-prompt-yes{background:var(--accent,#f59e0b);border-color:transparent;color:#1c1917;font-weight:600}' +
      '.push-prompt button:disabled{opacity:.6;cursor:default}';
    document.head.appendChild(s);
  }

  function show(onEnable) {
    css();
    var box = document.createElement('div');
    box.className = 'push-prompt';
    box.setAttribute('role', 'status');
    box.innerHTML = '<p><strong>Get notifications on this device?</strong><span class="push-prompt-text">The dashboard admin can then choose to send alerts here. Nothing is sent unless they pick this device.</span></p>' +
      '<div class="push-prompt-actions"><button type="button" class="push-prompt-no">Not now</button><button type="button" class="push-prompt-yes">Enable</button></div>';
    document.body.appendChild(box);
    var yes = box.querySelector('.push-prompt-yes'), no = box.querySelector('.push-prompt-no'), text = box.querySelector('.push-prompt-text');
    function done(message, ms) { text.textContent = message; box.querySelector('.push-prompt-actions').remove(); setTimeout(function () { box.remove(); }, ms); }
    no.addEventListener('click', function () { dismiss(); box.remove(); });
    yes.addEventListener('click', function () {
      yes.disabled = no.disabled = true;
      onEnable().then(function () {
        done('This device is registered. The admin can now choose to send notifications to it.', 6000);
      }).catch(function (e) {
        if (e && e.denied) { dismiss(); done('Notifications are blocked for this site in the browser settings.', 6000); return; }
        yes.disabled = no.disabled = false;
        text.textContent = (e && e.message) || 'Could not turn notifications on.';
      });
    });
  }

  function enable(reg) {
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { var err = new Error('Permission was not given.'); err.denied = perm === 'denied'; if (!err.denied) dismiss(); throw err; }
      return fetch('/api/push/key', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    }).then(function (k) {
      var key = keyBytes(k.publicKey);
      return reg.pushManager.getSubscription().then(function (sub) {
        // A subscription made with other server keys (an old install) cannot be reused.
        var existing = sub && sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
        if (sub && existing && existing.join(',') !== key.join(',')) return sub.unsubscribe().then(function () { return null; });
        return sub;
      }).then(function (sub) { return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); });
    }).then(function (sub) { return postJson('/api/push/register', { subscription: sub.toJSON() }); });
  }

  function start() {
    if (!supported() || Notification.permission === 'denied' || dismissedUntil() > Date.now()) return;
    navigator.serviceWorker.getRegistration('/').then(function (reg) { return reg || navigator.serviceWorker.register('/sw.js'); })
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          if (!sub) return reg;
          // Already subscribed: only offer the toast if the server no longer lists this browser.
          return sha256Hex(sub.endpoint).then(function (hash) { return postJson('/api/push/known', { endpoint_hash: hash }); })
            .then(function (r) { return r.known ? null : reg; });
        });
      })
      .then(function (reg) {
        if (!reg) return;
        setTimeout(function () { if (!document.hidden && dismissedUntil() <= Date.now()) show(function () { return enable(reg); }); }, DELAY_MS);
      })
      .catch(function () { /* push is optional: stay quiet */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
