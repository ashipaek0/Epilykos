/**
 * Settings > Prepaid meter (its own page; modules/prepaidMeter.js).
 *
 * One way to save: the switch, the two warning levels and who sees the balance are a draft until Save is pressed (the button
 * stays off until something changes); the switch only shows or hides the fields, and nothing is sent until Save. Below them the
 * balance with its buttons (the same dialogs as the dashboard card) and the latest entries: those are actions, not settings,
 * and take effect when their dialog is submitted (or Undo is pressed). Feedback is the page's toast.
 */
(function () {
  'use strict';
  var root = document.getElementById('pm-root');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var settings = null, view = null, loaded = false, dialogs = null, saving = false;
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) } : { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Server error ' + r.status)); return d; }); });
  }
  function tell(msg, tone) { if (window.stShell && window.stShell.toast) window.stShell.toast(msg, tone ? { tone: tone } : {}); }
  var fmt = function (n, d) { return new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n); };
  var when = function (t) { return new Date(t * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); };

  // ── The settings form: drawn once, from the saved settings ──
  function drawForm() {
    var s = settings;
    var h = '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="pm-enabled"' + (s.enabled ? ' checked' : '') + '><span class="slider"></span></label><label for="pm-enabled">Track a prepaid meter</label></span>';
    h += '<div id="pm-fields"' + (s.enabled ? '' : ' hidden') + '>';
    h += s.source === 'none'
      ? '<p class="st-help">No grid energy reading yet. Map a daily grid import or grid import power metric.</p>'
      : '<p class="st-help">Counting from <b>' + esc(s.metric) + '</b> (' + (s.source === 'counter' ? 'the daily grid import counter' : 'grid import power') + ').</p>';
    h += '<div class="st-grid-2">'
      + numField('pm-warn-kwh', 'Warn when units left fall to (kWh)', s.warnKwh) + numField('pm-warn-days', 'Warn when days left fall to', s.warnDays) + '</div>';
    h += '<p class="st-help">Sends <b>Prepaid meter low</b> and <b>Prepaid meter out of units</b> to your Notifications rules.</p>';
    h += '<div class="st-field"><label for="pm-private">Who can see the balance</label><select class="input" id="pm-private">'
      + '<option value="everyone"' + (s.privateBalance ? '' : ' selected') + '>Everyone who can see the dashboard</option>'
      + '<option value="private"' + (s.privateBalance ? ' selected' : '') + '>Only me, when signed in</option></select>'
      + '<span class="st-help"><b>Only me</b> hides the balance from anyone who is not signed in.</span></div>';
    h += '</div>';
    h += '<div><button type="button" class="st-btn st-btn-primary" id="pm-save" disabled>Save</button></div>';
    h += '<div id="pm-balance"></div>';
    root.innerHTML = h;
    var markDirty = function () { $('pm-save').disabled = saving || !changed(); };
    $('pm-enabled').addEventListener('change', function () { $('pm-fields').hidden = !$('pm-enabled').checked; drawBalance(); markDirty(); });
    ['pm-warn-kwh', 'pm-warn-days'].forEach(function (id) { $(id).addEventListener('input', markDirty); });
    $('pm-private').addEventListener('change', markDirty);
    $('pm-save').addEventListener('click', save);
    drawBalance();
  }
  function numField(id, label, value) {
    return '<div class="st-field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="number" min="0" step="any" inputmode="decimal" value="' + esc(value == null ? '' : value) + '"></div>';
  }
  function draft() {
    var num = function (id) { var v = $(id).value.trim(); return v === '' ? null : Number(v); };
    return { enabled: $('pm-enabled').checked, warnKwh: num('pm-warn-kwh'), warnDays: num('pm-warn-days'), privateBalance: $('pm-private').value === 'private' };
  }
  function changed() {
    var d = draft(), s = settings;
    return d.enabled !== s.enabled || d.warnKwh !== s.warnKwh || d.warnDays !== s.warnDays || d.privateBalance !== s.privateBalance;
  }

  function save() {
    var btn = $('pm-save'); if (saving || btn.disabled) return;
    saving = true; btn.disabled = true;
    api('/api/prepaid/settings', draft())
      .then(function (d) { settings = d; tell('Prepaid meter saved'); return api('/api/prepaid').then(function (v) { view = v; }); })
      .catch(function (e) { tell(e.message, 'error'); })
      .then(function () { saving = false; drawForm(); });
  }

  // ── The balance and its entries: shown for the saved settings, redrawn after every action ──
  function drawBalance() {
    var box = $('pm-balance'); if (!box) return;
    var v = view || {};
    if (!settings.enabled || !$('pm-enabled').checked || v.enabled === false) { box.innerHTML = ''; return; }
    var h = '<h2 class="st-card-subhead">Balance</h2>';
    if (v.started) {
      h += '<p><b>' + fmt(v.balance, 1) + ' kWh</b> left' + (v.daysLeft != null ? ', about ' + fmt(v.daysLeft, 1) + ' days at ' + fmt(v.avgDaily, 1) + ' kWh a day' : '') + (v.level === 'low' ? ' (low)' : v.level === 'out' ? ' (out of units)' : '') + '.</p>';
      if (v.lastCheck && v.lastCheck.errorKwh != null) h += '<p class="st-help">Last correction: the estimate was ' + fmt(Math.abs(v.lastCheck.errorKwh), 1) + ' kWh ' + (v.lastCheck.errorKwh > 0 ? 'high' : 'low') + (v.lastCheck.errorPct != null ? ' (' + fmt(Math.abs(v.lastCheck.errorPct), 1) + '% of what was used)' : '') + '.</p>';
    } else {
      h += '<p class="st-help">No balance yet. Enter what the meter shows to start counting.</p>';
    }
    h += '<div><button type="button" class="st-btn" id="pm-correct">' + (v.started ? 'Correct balance' : 'Set the balance') + '</button> ' + (v.started ? '<button type="button" class="st-btn" id="pm-recharge">Record recharge</button> ' : '') + (v.ledger && v.ledger.length ? '<button type="button" class="st-btn" id="pm-undo">Undo last entry</button>' : '') + '</div>';
    h += '<p class="st-help">Record recharges and correct the balance from your meter. These apply straight away.</p>';
    if (v.ledger && v.ledger.length) {
      h += '<h2 class="st-card-subhead">Latest entries</h2><div class="st-table-scroll"><table class="st-table"><thead><tr><th>Date</th><th>Entry</th><th>Units (kWh)</th><th>Paid</th></tr></thead><tbody>'
        + v.ledger.slice(0, 10).map(function (e) {
          var what = e.type === 'recharge' ? 'Recharge' : e.type === 'start' ? 'Starting balance' : 'Correction' + (e.errorKwh ? ' (was ' + (e.errorKwh > 0 ? '+' : '−') + fmt(Math.abs(e.errorKwh), 1) + ')' : '');
          return '<tr><td>' + esc(when(e.ts)) + '</td><td>' + esc(what) + '</td><td>' + (e.type === 'recharge' ? '+' : '=') + ' ' + fmt(e.units, 1) + '</td><td>' + (e.amount ? esc((v.currency || '') + ' ' + fmt(e.amount, 0)) + (e.price ? ' (' + fmt(e.price, 2) + ' per kWh)' : '') : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    box.innerHTML = h;
    $('pm-correct').addEventListener('click', function () { openDialog('correct'); });
    var re = $('pm-recharge'); if (re) re.addEventListener('click', function () { openDialog('recharge'); });
    var un = $('pm-undo'); if (un) un.addEventListener('click', function () {
      un.disabled = true;
      api('/api/prepaid/undo', {}).then(function (d) { view = d.view; tell('Last entry undone'); drawBalance(); }).catch(function (e) { tell(e.message, 'error'); un.disabled = false; });
    });
  }

  function openDialog(kind) {
    var ensure = dialogs ? Promise.resolve() : Promise.all([import('/js/components/prepaidDialogs.js'), import('/js/components/prepaidClient.js')])
      .then(function (m) { dialogs = m[0]; m[1].onPrepaid(function (data) { if (data && data.enabled && data.started !== undefined) { view = data; drawBalance(); } }); });
    ensure.then(function () { return api('/api/prepaid'); }).then(function (d) { view = d; if (kind === 'recharge') dialogs.openRechargeDialog(d); else dialogs.openCorrectDialog(d); })
      .catch(function (e) { tell(e.message, 'error'); });
  }

  function load() {
    if (loaded) return; loaded = true;
    root.innerHTML = '<p class="st-help">Loading…</p>';
    api('/api/prepaid/settings').then(function (s) { settings = s; return api('/api/prepaid'); })
      .then(function (d) { view = d; drawForm(); })
      .catch(function (e) {
        loaded = false;
        root.innerHTML = '<p class="st-help">' + esc(e.message) + '</p><div><button type="button" class="st-btn" id="pm-retry">Try again</button></div>';
        $('pm-retry').addEventListener('click', load);
      });
  }
  // Load when the section is first opened (the page shows one section at a time).
  var section = document.getElementById('section-prepaid');
  if (section && section.hidden) {
    new MutationObserver(function () { if (!section.hidden) load(); }).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  } else { load(); }
})();
