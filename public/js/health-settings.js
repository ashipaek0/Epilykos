/**
 * Settings → Health: the setup checks from /api/setup-health, one row each, with a button to the fix.
 * Everything is drawn with textContent. A warning can be hidden (and shown again); a failure cannot.
 * Loaded after settings-shell.js.
 */
(function () {
  'use strict';

  var root = document.getElementById('health-root');
  if (!root) return;
  var shell = window.stShell || {};
  var showHidden = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function api(path, body) {
    var opts = { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/setup-health' + path, opts).then(function (res) {
      if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  var TONE = { ok: 'is-ok', warn: 'is-warn', fail: 'is-error' };
  var WORD = { ok: 'OK', warn: 'To do', fail: 'Needs fixing' };

  function row(c) {
    var r = el('div', 'st-health-row is-' + c.level + (c.dismissed ? ' is-dismissed' : ''));
    var head = el('div', 'st-health-head');
    head.appendChild(el('span', 'st-badge ' + TONE[c.level], c.dismissed ? 'Hidden' : WORD[c.level]));
    head.appendChild(el('strong', 'st-health-title', c.title));
    r.appendChild(head);
    if (c.detail) r.appendChild(el('p', 'st-help st-health-detail', c.detail));
    var actions = el('div', 'st-health-actions');
    if (c.fix && c.level !== 'ok') {
      var go = el('a', 'st-btn', 'Open'); go.href = c.fix;
      actions.appendChild(go);
    }
    if (c.level === 'warn') {
      var hide = el('button', 'st-btn st-btn-quiet', c.dismissed ? 'Show again' : 'Hide');
      hide.type = 'button';
      hide.addEventListener('click', function () {
        api('/dismiss', { id: c.id, dismissed: !c.dismissed }).then(draw).catch(function (e) { if (shell.toast) shell.toast(e.message, { tone: 'error' }); });
      });
      actions.appendChild(hide);
    }
    if (actions.childNodes.length) r.appendChild(actions);
    return r;
  }

  function draw(data) {
    var checks = (data && data.checks) || [];
    var attention = (data && data.attention) || 0;
    var badge = document.getElementById('health-badge');
    if (badge) {
      badge.hidden = false;
      badge.className = 'st-badge ' + (attention ? 'is-warn' : 'is-ok');
      badge.textContent = attention ? attention + (attention === 1 ? ' to look at' : ' to look at') : 'All good';
    }
    if (shell.setNavBadge) {
      var n = checks.some(function (c) { return c.level === 'fail'; }) ? 'is-error' : 'is-warn';
      shell.setNavBadge('health', attention ? '<span class="st-badge ' + n + '">' + attention + '</span>' : '');
    }
    root.textContent = '';
    var shown = checks.filter(function (c) { return showHidden || !c.dismissed; });
    // Things to do first, then what is fine.
    var order = { fail: 0, warn: 1, ok: 2 };
    shown.sort(function (a, b) { return order[a.level] - order[b.level]; });
    shown.forEach(function (c) { root.appendChild(row(c)); });
    var nHidden = checks.filter(function (c) { return c.dismissed; }).length;
    if (nHidden) {
      var t = el('button', 'st-btn st-btn-quiet', showHidden ? 'Hide the ' + nHidden + ' hidden' : 'Show ' + nHidden + ' hidden');
      t.type = 'button';
      t.addEventListener('click', function () { showHidden = !showHidden; draw(data); });
      root.appendChild(t);
    }
  }

  function load() {
    return api('').then(draw).catch(function (e) {
      root.textContent = '';
      root.appendChild(el('p', 'st-help', 'The checks could not run: ' + e.message));
    });
  }

  load();
  window.addEventListener('hashchange', function () { if (location.hash === '#health') load(); });
})();
