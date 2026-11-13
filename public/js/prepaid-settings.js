/**
 * Settings > Prepaid meter (its own page; modules/prepaidMeter.js).
 *
 * Switches tracking on, sets the warning levels (units left, days left; both optional) and who sees the balance, shows the
 * balance with the buttons to add a recharge or correct it by hand (the same dialogs as the dashboard card), and lists the
 * latest entries with an undo for the last one. Saves straight away through /api/prepaid (data-own-save card).
 */
(function () {
  'use strict';
  var root = document.getElementById('pm-root');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var settings = null, view = null, loaded = false, dialogs = null, client = null;
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) } : { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Server error ' + r.status)); return d; }); });
  }
  function status(msg, ok) { var el = $('pm-status'); el.className = 'status' + (msg ? (ok ? ' success' : ' error') : ''); el.textContent = msg || ''; }
  function toggle(id, label, on) {
    return '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span class="slider"></span></label><label for="' + id + '">' + label + '</label></span>';
  }
  function num(id, label, value, help) {
    return '<div class="st-field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="number" min="0" step="any" inputmode="decimal" value="' + esc(value == null ? '' : value) + '" placeholder="No warning">' + (help ? '<span class="st-help">' + help + '</span>' : '') + '</div>';
  }
  var fmt = function (n, d) { return new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n); };
  var when = function (t) { return new Date(t * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); };

  function render() {
    var s = settings, v = view || {};
    var h = toggle('pm-enabled', 'Track a prepaid meter', s.enabled);
    if (s.enabled) {
      h += s.source === 'none'
        ? '<p class="st-help">There is no grid energy reading to count yet. Map a daily grid import metric (Metrics page), or a grid import power metric.</p>'
        : '<p class="st-help">Counting from <b>' + esc(s.metric) + '</b> (' + (s.source === 'counter' ? 'the daily grid import counter' : 'grid import power') + ').</p>';
      h += '<div class="st-grid-2">' + num('pm-warn-kwh', 'Warn when units left fall to (kWh)', s.warnKwh) + num('pm-warn-days', 'Warn when days left fall to', s.warnDays) + '</div>';
      h += '<p class="st-help">Either, both or neither. A warning sends the event <b>Prepaid meter low</b> to your notification rules; <b>Prepaid meter out of units</b> is sent when the balance reaches 0. Add an event rule for them under Notifications.</p>';
      h += '<div class="st-field"><label for="pm-private">Who can see the balance</label><select class="input" id="pm-private">'
        + '<option value="everyone"' + (s.privateBalance ? '' : ' selected') + '>Everyone who can see the dashboard</option>'
        + '<option value="private"' + (s.privateBalance ? ' selected' : '') + '>Only me, when signed in</option></select>'
        + '<span class="st-help">Recharges, corrections, the entries and these settings always need you to be signed in. <b>Only me</b> also keeps the balance out of the published metrics, so no other card or chart can show it for a viewer; the Prepaid meter card and the Grid card strip then show nothing to anyone who is not signed in.</span></div>';
    }
    h += '<div><button type="button" class="st-btn st-btn-primary" id="pm-save">Save</button></div>';
    if (s.enabled) {
      h += '<h2 class="st-card-subhead">Balance</h2>';
      if (v.started) {
        h += '<p><b>' + fmt(v.balance, 1) + ' kWh</b> left' + (v.daysLeft != null ? ', about ' + fmt(v.daysLeft, 1) + ' days at ' + fmt(v.avgDaily, 1) + ' kWh a day' : '') + (v.level === 'low' ? ' (low)' : v.level === 'out' ? ' (out of units)' : '') + '.</p>';
        if (v.lastCheck && v.lastCheck.errorKwh != null) h += '<p class="st-help">Last correction: the estimate was ' + fmt(Math.abs(v.lastCheck.errorKwh), 1) + ' kWh ' + (v.lastCheck.errorKwh > 0 ? 'high' : 'low') + (v.lastCheck.errorPct != null ? ' (' + fmt(Math.abs(v.lastCheck.errorPct), 1) + '% of what was used)' : '') + '.</p>';
      } else {
        h += '<p class="st-help">No balance yet. Enter what the meter shows to start counting.</p>';
      }
      h += '<div><button type="button" class="st-btn" id="pm-correct">' + (v.started ? 'Correct balance' : 'Set the balance') + '</button> ' + (v.started ? '<button type="button" class="st-btn" id="pm-recharge">Record recharge</button> ' : '') + (v.ledger && v.ledger.length ? '<button type="button" class="st-btn" id="pm-undo">Undo last entry</button>' : '') + '</div>';
      h += '<p class="st-help">These buttons only record what you have done by hand: Epilykos cannot buy a token, load one or read the meter. After you buy and load a token, record the units. Whenever the estimate has drifted, read the meter and correct the balance to match; Epilykos can learn from the difference, so later estimates drift less.</p>';
      if (v.ledger && v.ledger.length) {
        h += '<h2 class="st-card-subhead">Latest entries</h2><div class="st-table-scroll"><table class="st-table"><thead><tr><th>Date</th><th>Entry</th><th>Units (kWh)</th><th>Paid</th></tr></thead><tbody>'
          + v.ledger.slice(0, 10).map(function (e) {
            var what = e.type === 'recharge' ? 'Recharge' : e.type === 'start' ? 'Starting balance' : 'Correction' + (e.errorKwh ? ' (was ' + (e.errorKwh > 0 ? '+' : '−') + fmt(Math.abs(e.errorKwh), 1) + ')' : '');
            return '<tr><td>' + esc(when(e.ts)) + '</td><td>' + esc(what) + '</td><td>' + (e.type === 'recharge' ? '+' : '=') + ' ' + fmt(e.units, 1) + '</td><td>' + (e.amount ? esc((v.currency || '') + ' ' + fmt(e.amount, 0)) + (e.price ? ' (' + fmt(e.price, 2) + ' per kWh)' : '') : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    }
    root.innerHTML = h;
    bind();
  }

  function bind() {
    var en = $('pm-enabled');
    en.addEventListener('change', save);
    $('pm-save').addEventListener('click', save);
    if (!settings.enabled) return;
    $('pm-correct').addEventListener('click', function () { openDialog('correct'); });
    var re = $('pm-recharge'); if (re) re.addEventListener('click', function () { openDialog('recharge'); });
    var un = $('pm-undo'); if (un) un.addEventListener('click', function () {
      un.disabled = true;
      api('/api/prepaid/undo', {}).then(function (d) { view = d.view; status('Last entry undone.', true); render(); }).catch(function (e) { status(e.message, false); un.disabled = false; });
    });
  }

  function save() {
    var body = { enabled: !!$('pm-enabled').checked };
    if (body.enabled && $('pm-warn-kwh')) {
      body.warnKwh = $('pm-warn-kwh').value.trim() === '' ? null : Number($('pm-warn-kwh').value);
      body.warnDays = $('pm-warn-days').value.trim() === '' ? null : Number($('pm-warn-days').value);
      body.privateBalance = $('pm-private').value === 'private';
    }
    status('Saving…', true);
    api('/api/prepaid/settings', body).then(function (d) { settings = d; status('Saved.', true); return refresh(); }).catch(function (e) { status(e.message, false); });
  }

  function openDialog(kind) {
    var ensure = dialogs ? Promise.resolve() : Promise.all([import('/js/components/prepaidDialogs.js'), import('/js/components/prepaidClient.js')]).then(function (m) { dialogs = m[0]; client = m[1]; client.onPrepaid(function (data) { if (data && data.enabled) { view = data; render(); } }); });
    ensure.then(function () { return api('/api/prepaid'); }).then(function (d) { view = d; if (kind === 'recharge') dialogs.openRechargeDialog(d); else dialogs.openCorrectDialog(d); });
  }

  function refresh() { return api('/api/prepaid').then(function (d) { view = d; render(); }).catch(function (e) { status(e.message, false); }); }

  function load() {
    if (loaded) return; loaded = true;
    api('/api/prepaid/settings').then(function (s) { settings = s; return api('/api/prepaid'); }).then(function (d) { view = d; render(); }).catch(function (e) { root.innerHTML = '<p class="st-help">' + esc(e.message) + '</p>'; loaded = false; });
  }
  // Load when the section is first opened (the page shows one section at a time).
  var section = document.getElementById('section-prepaid');
  if (section && section.hidden) {
    new MutationObserver(function () { if (!section.hidden) load(); }).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  } else { load(); }
})();
