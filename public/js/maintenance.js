/** Dashboard warnings and backup status. */
(function () {
  'use strict';
  var card = null, banner = null;
  var section = document.getElementById('section-backup');
  if (section) {
    card = document.createElement('div'); card.className = 'st-card';
    card.innerHTML = '<h2>Database health and backups</h2><p data-maint-status></p><button type="button" class="st-btn" data-maint-check>Check the database now</button> <button type="button" class="st-btn" data-maint-snooze>Remind me about backups in 7 days</button>';
    section.appendChild(card);
    card.querySelector('[data-maint-check]').onclick = function () { fetch('/api/notices/database/check', { method: 'POST' }).then(refresh); };
    card.querySelector('[data-maint-snooze]').onclick = function () { fetch('/api/notices/backup/snooze', { method: 'POST' }).then(refresh); };
  } else if (document.getElementById('setup-banner')) {
    banner = document.createElement('div'); banner.className = 'setup-banner'; banner.hidden = true;
    document.getElementById('setup-banner').after(banner);
  }
  function refresh() {
    return fetch('/api/notices').then(function (r) { if (!r.ok) throw new Error('Maintenance status unavailable'); return r.json(); }).then(function (r) {
      if (card) {
        var db = r.database.last;
        card.querySelector('[data-maint-status]').textContent = 'Last backup download: ' + (r.backup.last ? new Date(r.backup.last).toLocaleString() : 'none recorded') + '. Database: ' + (r.database.running ? 'checking…' : db ? (db.ok ? 'OK' : db.problems.join('; ')) + ' (' + new Date(db.at).toLocaleString() + ')' : 'not checked yet') + '. Keep a backup outside this device; snapshots on the SD card cannot protect against card failure.';
        card.querySelector('[data-maint-check]').disabled = r.database.running;
      }
      if (banner) {
        banner.replaceChildren(); banner.hidden = !r.notices.length;
        r.notices.forEach(function (n) { var a = document.createElement('a'); a.className = 'setup-banner-btn'; a.href = n.href; a.textContent = n.message; banner.appendChild(a); });
      }
    }).catch(function (e) { if (card) card.querySelector('[data-maint-status]').textContent = e.message; });
  }
  refresh(); setInterval(refresh, 30000);
  document.addEventListener('st:section-shown', refresh);
})();
