/**
 * Maintenance status (routes/notices.js):
 *   Settings → Backup and restore: last backup download, the database
 *     check, "Check the database now" and the backup reminder snooze.
 *   Dashboard: one banner listing what needs the administrator's attention.
 *     Signed-in only: /api/notices answers 401 otherwise, and then nothing
 *     is shown and polling stops.
 */
(function () {
  'use strict';
  var card = null, banner = null, timer = null;
  var section = document.getElementById('section-backup');
  var setupBanner = document.getElementById('setup-banner');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  if (section) {
    card = el('div', 'st-card');
    card.innerHTML = '<div class="st-card-head"><h2>Database health and backups</h2></div>'
      + '<p class="st-help" data-maint-backup></p><p class="st-help" data-maint-db></p>'
      + '<p class="st-help">Keep a backup outside this device: snapshots on the SD card cannot protect against the card failing.</p>'
      + '<div class="st-inline-actions"><button type="button" class="st-btn" data-maint-check>Check the database now</button>'
      + '<button type="button" class="st-btn" data-maint-snooze>Remind me about backups in 7 days</button></div>'
      + '<div class="test-status" data-maint-status role="status"></div>';
    section.appendChild(card);
    card.querySelector('[data-maint-check]').onclick = function () { post('/api/notices/database/check'); };
    card.querySelector('[data-maint-snooze]').onclick = function () { post('/api/notices/backup/snooze', 'The backup reminder is paused for 7 days.'); };
  } else if (setupBanner) {
    banner = el('div', 'setup-banner notice-banner');
    banner.setAttribute('role', 'status');
    banner.style.display = 'none';   // .setup-banner's display:flex would override [hidden]
    setupBanner.after(banner);
  }
  if (!card && !banner) return;

  function post(path, done) {
    var status = card.querySelector('[data-maint-status]');
    status.className = 'test-status'; status.textContent = '';
    fetch(path, { method: 'POST' }).then(function (r) {
      if (!r.ok) throw new Error('The request failed (' + r.status + ')');
      if (done) { status.className = 'test-status success'; status.textContent = done; }
      return refresh();
    }).catch(function (e) { status.className = 'test-status error'; status.textContent = e.message; });
  }

  function when(iso) { return new Date(iso).toLocaleString(); }

  function renderCard(r) {
    var b = r.backup || {}, d = r.database || {}, last = d.last;
    card.querySelector('[data-maint-backup]').textContent = 'Last backup download: ' + (b.last ? when(b.last) : 'none recorded') + '.';
    card.querySelector('[data-maint-db]').textContent = 'Database check: ' + (d.running ? 'checking now…'
      : last ? (last.ok ? 'no problems found' : 'found problems: ' + (last.problems || []).join('; ')) + ' (' + when(last.at) + ')'
        : 'not run yet') + '.';
    card.querySelector('[data-maint-check]').disabled = !!d.running;
  }

  function renderBanner(notices) {
    banner.replaceChildren();
    if (!notices.length) { banner.style.display = 'none'; return; }
    var list = el('div', 'notice-banner-list');
    notices.forEach(function (n) {
      var row = el('div', 'notice-banner-item');
      row.appendChild(el('span', null, n.message));
      var a = el('a', 'notice-banner-link', 'Open settings');
      a.href = n.href || '/settings';
      row.appendChild(a);
      list.appendChild(row);
    });
    banner.appendChild(list);
    banner.classList.toggle('is-critical', notices.some(function (n) { return n.id === 'database' || n.severity === 'critical'; }));
    banner.style.display = '';
  }

  function stop() { clearInterval(timer); timer = null; }

  function refresh() {
    return fetch('/api/notices', { headers: { Accept: 'application/json' } }).then(function (r) {
      if (r.status === 401 || r.status === 403) { stop(); return null; }   // signed out: nothing to show
      if (!r.ok) throw new Error('Maintenance status is unavailable right now.');
      return r.json();
    }).then(function (r) {
      if (!r) { if (banner) banner.style.display = 'none'; return; }
      if (card) renderCard(r);
      if (banner) renderBanner(r.notices || []);
    }).catch(function (e) {
      if (card) card.querySelector('[data-maint-db]').textContent = e.message;
      if (banner) banner.style.display = 'none';
    });
  }

  refresh();
  timer = setInterval(refresh, 30000);
  if (card) document.addEventListener('st:section-shown', function (ev) { if (ev.detail && ev.detail.section === 'backup') refresh(); });
})();
