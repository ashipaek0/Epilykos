/**
 * Settings > Metrics > Battery estimate (modules/batteryEstimator.js).
 *
 * Shows the estimate and how it got there (voltage guess, last full charge,
 * time not counted), and edits its settings: battery, the inverters' battery
 * current and voltage readings, when the battery counts as full or empty.
 * Empty number fields take the chemistry's default, shown as the placeholder.
 * Saves straight away through /api/battery-estimator (data-own-save card).
 */
(function () {
  'use strict';
  var root = document.getElementById('be-root');
  if (!root) return;
  var view = null, rendered = false;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) } : { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Server error ' + r.status)); return d; }); });
  }
  function status(msg, ok) { var el = $('be-status'); el.className = 'status' + (msg ? (ok ? ' success' : ' error') : ''); el.textContent = msg || ''; }
  function when(t) {
    if (!t) return '';
    var d = new Date(t * 1000), today = new Date();
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === today.toDateString() ? 'today ' + time : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
  }
  function toggle(id, label, on) {
    return '<span class="toggle-wrap"><label class="toggle-switch"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span class="slider"></span></label><label for="' + id + '">' + label + '</label></span>';
  }
  function field(id, label, value, opts) {
    opts = opts || {};
    return '<div class="st-field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" value="' + esc(value == null ? '' : value) + '"'
      + (opts.type ? ' type="' + opts.type + '" step="any" inputmode="decimal"' : ' spellcheck="false" autocomplete="off"') + (opts.placeholder != null ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>'
      + (opts.help ? '<span class="st-help">' + opts.help + '</span>' : '') + '</div>';
  }
  function select(id, label, value, options, help) {
    return '<div class="st-field"><label for="' + id + '">' + label + '</label><select class="input" id="' + id + '">'
      + options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'
      + (help ? '<span class="st-help">' + help + '</span>' : '') + '</div>';
  }

  // Defaults for the chosen chemistry, system voltage, cells and capacity (as the server works them out).
  function defaults() {
    var chem = view.chemistries[$('be-chemistry').value] || view.chemistries.lifepo4;
    var usual = chem.cells[$('be-nominal').value] || chem.cells[48];
    var own = Number($('be-cells').value);
    var cells = own >= 1 && own <= 32 && Math.round(own) === own ? own : usual;
    var cap = Number($('be-capacity').value) || 0;
    var r = function (v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f; };
    return {
      charge_efficiency: chem.efficiency, full_voltage: r(chem.full_cell * cells, 2), tail_current_a: cap ? r(cap * chem.tail_pct / 100, 1) : '',
      full_minutes: chem.full_minutes, empty_voltage: r(chem.empty_cell * cells, 2), empty_soc: chem.empty_soc, cells: usual
    };
  }
  function placeholders() {
    var d = defaults();
    Object.keys(d).forEach(function (k) { var el = $('be-' + k.replace(/_/g, '-')); if (el) el.placeholder = d[k] === '' ? '' : String(d[k]); });
  }

  function statusHtml() {
    var s = view.status, e = view.effective;
    if (!view.settings.enabled) return '';
    if (!e.enabled) return '<p class="st-help">Not counting: enter the capacity and the battery current readings.</p>';
    if (!s) return '<p class="st-help">Starts with the next reading (within 30 seconds).</p>';
    if (s.waiting && !s.mismatch) return '<p class="st-help">Waiting for a battery voltage reading to start from.</p>';
    if (s.waiting) return '<p class="test-status error">' + mismatchText(s.mismatch) + ' Counting starts once it fits.</p>';
    var lines = [];
    var now = '<b>' + s.soc + '%</b> · ' + s.ah + ' Ah of ' + e.capacity_ah + ' Ah';
    if (s.current != null) now += ' · ' + (s.current > 0 ? 'charging ' : s.current < 0 ? 'discharging ' : '') + Math.abs(s.current) + ' A';
    if (s.voltage != null) now += ' · ' + s.voltage + ' V';
    lines.push(now);
    var from = { voltage: 'Started from the battery voltage ' + when(s.origin_at) + ', which is only a rough guess; it becomes accurate at the next full charge.',
      full: 'Battery full ' + when(s.origin_at) + '; counted since.', empty: 'Set to ' + e.empty_soc + '% at low voltage ' + when(s.origin_at) + '; counted since.',
      manual: 'Set by hand ' + when(s.origin_at) + '; counted since.' }[s.origin];
    if (from) lines.push(from);
    if (s.last_full && s.origin !== 'full') lines.push('Last full: ' + when(s.last_full) + '.');
    if (s.full_for_s) lines.push('Looks full; set to 100% after ' + e.full_minutes + ' minutes like this (' + Math.floor(s.full_for_s / 60) + ' so far).');
    if (s.uncounted_s >= 60) lines.push('Not counted: ' + Math.round(s.uncounted_s / 60) + ' min with no readings since then, so it may be off until the next full charge.');
    if (s.missing && s.missing.length) lines.push('No recent reading from ' + s.missing.map(esc).join(', ') + '.');
    if (s.mismatch) lines.push('<span class="test-status error" style="display:inline;padding:0">' + mismatchText(s.mismatch) + ' Counting goes on, but the full and empty resets wait until it fits.</span>');
    return '<div class="st-snapshots"><div class="st-snapshot"><div style="min-width:0">' + lines.map(function (l, i) { return i ? '<span class="st-help" style="display:block">' + l + '</span>' : '<span class="st-snapshot-date" style="display:block">' + l + '</span>'; }).join('') + '</div></div></div>';
  }

  // The battery voltage doesn't fit the pack: System voltage or Cells in series is wrong.
  function mismatchText(m) {
    return 'The battery reads ' + m.voltage + ' V, which doesn\u2019t fit a ' + m.nominal_voltage + ' V pack of ' + m.cells + ' cells (' + m.pack_voltage + ' V). Check System voltage and Cells in series.';
  }

  function render() {
    var s = view.settings || {}, sug = view.suggestions || {};
    var cur = (s.current_inputs && s.current_inputs.length ? s.current_inputs : sug.current_inputs || []).join(', ');
    var volt = (s.voltage_inputs && s.voltage_inputs.length ? s.voltage_inputs : sug.voltage_inputs || []).join(', ');
    // Readings found on the inverters, mentioned when the field holds something else.
    var found = function (list, value) { return list && list.length && list.join(', ') !== value ? ' Found on your inverters: ' + list.map(esc).join(', ') + '.' : ''; };
    var chems = Object.keys(view.chemistries).map(function (k) { return [k, view.chemistries[k].label]; });
    root.innerHTML = '<div data-be-now>' + statusHtml() + '</div>'
      + '<div class="st-toggle-row" style="margin-top:12px">' + toggle('be-enabled', 'Count the battery’s charge', !!s.enabled) + toggle('be-role', 'Use it as Battery %', !!s.use_for_role) + '</div>'
      + '<h2 class="st-card-subhead">Battery</h2><div class="st-grid-2">'
      + select('be-chemistry', 'Type', s.chemistry || 'lifepo4', chems)
      + select('be-nominal', 'System voltage', s.nominal_voltage || view.detected_nominal || 48, [[12, '12 V'], [24, '24 V'], [48, '48 V']],
        view.detected_nominal && view.detected_nominal !== s.nominal_voltage ? 'Your inverters say ' + view.detected_nominal + ' V.' : '')
      + field('be-capacity', 'Capacity (Ah)', s.capacity_ah, { type: 'number', help: 'The whole bank, at system voltage: two 200 Ah packs in parallel are 400 Ah.' })
      + field('be-charge-efficiency', 'Charge efficiency', s.charge_efficiency, { type: 'number', help: 'Share of the charge that stays in the battery (0.5 to 1).' })
      + field('be-cells', 'Cells in series', s.cells, { type: 'number', help: 'Empty: the usual count for this voltage. Set it for other packs, for example 15 for some 48 V LiFePO4.' })
      + '</div><h2 class="st-card-subhead">Readings</h2><div class="st-grid-2">'
      + field('be-current', 'Battery current (+ while charging)', cur, { help: 'One per inverter on this battery, separated by commas: each inverter only sees its own share.' + found(sug.current_inputs, cur) })
      + field('be-voltage', 'Battery voltage', volt, { help: 'Averaged if more than one.' + found(sug.voltage_inputs, volt) })
      + '</div><h2 class="st-card-subhead">Full and empty</h2><p class="st-help">Empty fields use the value shown, the usual one for this battery. Use your charger’s settings if they differ: full is a little under the absorption voltage.</p><div class="st-grid-2">'
      + field('be-full-voltage', 'Full at or above (V)', s.full_voltage, { type: 'number' })
      + field('be-tail-current-a', 'With the current settled within (A)', s.tail_current_a, { type: 'number', help: 'Charging has tapered off to this or less.' })
      + field('be-full-minutes', 'For (minutes)', s.full_minutes, { type: 'number' })
      + '</div><div class="st-toggle-row">' + toggle('be-empty', 'Reset at low voltage under a light load', s.empty_enabled !== false) + '</div><div class="st-grid-2">'
      + field('be-empty-voltage', 'Low voltage at or below (V)', s.empty_voltage, { type: 'number' })
      + field('be-empty-soc', 'Means a charge of (%)', s.empty_soc, { type: 'number' })
      + '</div><div class="st-inline-actions"><button type="button" class="st-btn st-btn-primary" id="be-save">Save</button></div>'
      + '<h2 class="st-card-subhead">Set the charge now</h2><p class="st-help">If you know it, for example from the battery’s own app, or right after a full charge.</p>'
      + '<div class="st-inline-actions"><input class="input" id="be-set-soc" type="number" min="0" max="100" step="1" inputmode="numeric" placeholder="%" style="max-width:110px" aria-label="Charge in %"><button type="button" class="st-btn" id="be-set">Set charge</button></div>';
    rendered = true;
    placeholders();
  }
  function renderNow() { var box = root.querySelector('[data-be-now]'); if (box) box.innerHTML = statusHtml(); }

  function load(full) {
    return api('/api/battery-estimator').then(function (d) { view = d; if (full || !rendered) render(); else renderNow(); })
      .catch(function (err) { if (!rendered) root.innerHTML = '<p class="st-help">' + esc(err.message) + '</p>'; });
  }

  root.addEventListener('change', function (e) {
    if (e.target.id === 'be-chemistry' || e.target.id === 'be-nominal') placeholders();
  });
  root.addEventListener('input', function (e) { if (e.target.id === 'be-capacity' || e.target.id === 'be-cells') placeholders(); });
  root.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.id === 'be-save') {
      var v = function (id) { return $(id).value.trim(); };
      var settings = {
        enabled: $('be-enabled').checked, use_for_role: $('be-role').checked, chemistry: v('be-chemistry'), nominal_voltage: Number(v('be-nominal')),
        capacity_ah: v('be-capacity') === '' ? 0 : Number(v('be-capacity')), cells: v('be-cells'), current_inputs: v('be-current'), voltage_inputs: v('be-voltage'),
        charge_efficiency: v('be-charge-efficiency'), full_voltage: v('be-full-voltage'), tail_current_a: v('be-tail-current-a'), full_minutes: v('be-full-minutes'),
        empty_enabled: $('be-empty').checked, empty_voltage: v('be-empty-voltage'), empty_soc: v('be-empty-soc')
      };
      b.disabled = true;
      api('/api/battery-estimator', { settings: settings })
        .then(function (d) {
          view = d; render();
          // The Metric roles card above shows (and saves) Battery %: show the role as it is now.
          if (typeof window.loadRoleMetrics === 'function') window.loadRoleMetrics();
          status('Saved.' + (settings.enabled && settings.use_for_role ? ' Battery % now uses the estimate.' : ''), true); })
        .catch(function (err) { status(err.message); })
        .then(function () { b.disabled = false; });
    }
    if (b.id === 'be-set') {
      var pct = $('be-set-soc').value.trim();
      if (pct === '') { status('Enter the charge in %.'); return; }
      b.disabled = true;
      api('/api/battery-estimator/soc', { soc: Number(pct) })
        .then(function (d) { view = d; renderNow(); $('be-set-soc').value = ''; status('Charge set to ' + Number(pct) + '%; counting from here.', true); })
        .catch(function (err) { status(err.message); })
        .then(function () { b.disabled = false; });
    }
  });

  load(true);
  // The figures move with every reading: refresh them while the Metrics section is on screen.
  setInterval(function () {
    var sec = document.getElementById('section-metrics');
    if (!document.hidden && sec && !sec.hidden) load(false);
  }, 30000);
  document.addEventListener('st:section-shown', function (e) { if (e.detail && e.detail.section === 'metrics') load(false); });
})();
