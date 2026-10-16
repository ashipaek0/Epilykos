/**
 * Settings → Logs. Self-contained: talks to /api/logs (signed-in only). The
 * level saves on its own; the list follows new lines every few seconds while
 * this section is open and the tab is visible. Loaded after settings-shell.js.
 */
(function () {
  'use strict';

  var list = document.getElementById('lg-list');
  if (!list) return;
  var shell = window.stShell || {};
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }
  function $(id) { return document.getElementById(id); }

  var POLL_MS = 3000, MAX_LINES = 1500;
  var lastSeq = 0, timer = null, open = false, busy = false, shown = 0;
  var LEVEL_LABEL = { error: 'Errors only', warn: 'Errors and warnings', info: 'Normal', http: 'Normal and web requests', debug: 'Debug' };

  function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }, opts.headers || {});
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function query(after) {
    var p = new URLSearchParams({ after: String(after || 0), limit: after ? '500' : '1000' });
    if ($('lg-show').value) p.set('level', $('lg-show').value);
    if ($('lg-source').value) p.set('source', $('lg-source').value);
    if ($('lg-search').value.trim()) p.set('q', $('lg-search').value.trim());
    return '/api/logs?' + p.toString();
  }

  function time(ts) {
    var d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }

  function lineEl(e) {
    var row = document.createElement('div');
    row.className = 'lg-line lg-' + e.level;
    var t = document.createElement('time'); t.dateTime = new Date(e.ts).toISOString(); t.title = new Date(e.ts).toLocaleString(); t.textContent = time(e.ts);
    var lvl = document.createElement('span'); lvl.className = 'lg-lvl'; lvl.textContent = e.level;
    var src = document.createElement('span'); src.className = 'lg-src'; src.textContent = e.source;
    var msg = document.createElement('span'); msg.className = 'lg-msg'; msg.textContent = e.message;
    row.append(t, lvl, src, msg);
    return row;
  }

  function nearBottom() { return list.scrollHeight - list.scrollTop - list.clientHeight < 40; }

  function renderLevel(data) {
    var sel = $('lg-level');
    if (document.activeElement !== sel) sel.value = data.level;
    var help = 'Applies straight away, no restart needed.';
    if (data.revertAt) help = 'Debug is on until ' + new Date(data.revertAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ', then back to ' + (LEVEL_LABEL[data.baseLevel] || data.baseLevel) + '. It includes the Bluetooth helper.';
    else if (data.envLevel && data.envLevel !== data.level) help += ' This overrides LOG_LEVEL=' + data.envLevel + ' from your Docker settings.';
    $('lg-level-help').textContent = help;
  }

  function renderSources(sources) {
    var sel = $('lg-source'), keep = sel.value;
    var have = Array.prototype.map.call(sel.options, function (o) { return o.value; }).slice(1);
    if (have.join() === sources.join()) return;
    sel.replaceChildren(new Option('All sources', ''));
    sources.forEach(function (s) { sel.appendChild(new Option(s, s)); });
    if (keep && sources.indexOf(keep) === -1) sel.appendChild(new Option(keep, keep));
    sel.value = keep;
  }

  function load(fresh) {
    if (busy) return Promise.resolve();
    busy = true;
    return api(query(fresh ? 0 : lastSeq)).then(function (data) {
      var stick = fresh || nearBottom();
      if (fresh) { list.replaceChildren(); shown = 0; }
      var frag = document.createDocumentFragment();
      data.entries.forEach(function (e) { frag.appendChild(lineEl(e)); });
      list.appendChild(frag);
      shown += data.entries.length;
      while (list.childElementCount > MAX_LINES) { list.firstElementChild.remove(); shown--; }
      if (!list.childElementCount) {
        var p = document.createElement('p'); p.className = 'st-help lg-empty';
        p.textContent = $('lg-search').value || $('lg-show').value || $('lg-source').value ? 'No lines match.' : 'Nothing logged yet.';
        list.appendChild(p);
      } else { var empty = list.querySelector('.lg-empty'); if (empty) empty.remove(); }
      lastSeq = data.lastSeq;
      $('lg-count').textContent = list.querySelectorAll('.lg-line').length + ' shown · the last ' + data.capacity.toLocaleString() + ' lines are kept';
      renderLevel(data);
      renderSources(data.sources || []);
      if (stick) list.scrollTop = list.scrollHeight;
    }).catch(function (e) {
      if (fresh) { list.replaceChildren(); var p = document.createElement('p'); p.className = 'st-help'; p.textContent = 'Could not load the log: ' + e.message; list.appendChild(p); }
    }).then(function () { busy = false; });
  }

  function schedule() {
    clearTimeout(timer);
    if (!open || !$('lg-live').checked || document.hidden) return;
    timer = setTimeout(function () { load(false).then(schedule); }, POLL_MS);
  }

  var searchTimer = null;
  function refilter() { load(true).then(schedule); }
  $('lg-show').addEventListener('change', refilter);
  $('lg-source').addEventListener('change', refilter);
  $('lg-search').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(refilter, 300); });
  $('lg-live').addEventListener('change', function () { if ($('lg-live').checked) load(false).then(schedule); else clearTimeout(timer); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && open) load(false).then(schedule); else clearTimeout(timer); });

  $('lg-level').addEventListener('change', function () {
    var sel = this, level = sel.value;
    sel.disabled = true;
    api('/api/logs/level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: level }) })
      .then(function () { toast(level === 'debug' ? 'Debug logging on for 30 minutes' : 'Log level: ' + LEVEL_LABEL[level]); return load(false); })
      .catch(function (e) { toast('Could not change it: ' + e.message, 'error'); })
      .then(function () { sel.disabled = false; });
  });

  document.addEventListener('st:section-shown', function (ev) {
    open = ev.detail && ev.detail.section === 'logs';
    if (open) refilter(); else clearTimeout(timer);
  });
  if (shell.hydrateIcons) shell.hydrateIcons(document.getElementById('section-logs'));
})();
