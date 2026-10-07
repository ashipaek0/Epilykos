/**
 * Settings > Metrics > Combined metrics.
 *
 * Lists the combined metrics (modules/combinedMetrics.js) with their live
 * value or why they are waiting, and edits them: name, unit, calculation,
 * inputs in order (with weights where needed) and a preview against current
 * readings. Saves straight away through /api/combined-metrics; the card is
 * marked data-own-save so the page's save bar ignores it.
 */
(function () {
  'use strict';
  var FN_INFO = {
    sum: { label: 'Add up', help: 'All inputs added together, e.g. PV1 + PV2 of each inverter.', many: true },
    mean: { label: 'Average', help: 'The average of the inputs.', many: true },
    min: { label: 'Lowest', help: 'The lowest of the inputs.', many: true },
    max: { label: 'Highest', help: 'The highest of the inputs.', many: true },
    difference: { label: 'Subtract', help: 'The first input minus the others, e.g. load minus solar.', many: true, ordered: true },
    product: { label: 'Multiply', help: 'Inputs multiplied, e.g. voltage × current = power.', many: true },
    weighted_mean: { label: 'Weighted average', help: 'Each input counts by its weight, e.g. battery charge weighted by capacity (Ah or kWh).', many: true, weights: true },
    scale: { label: 'Scale', help: 'One input × factor + offset, e.g. Wh to kWh (factor 0.001).', single: true },
    energy_today: { label: 'Energy today from power', help: 'kWh so far today from a power reading (inputs are added first). Resets at midnight.', many: true, energy: true },
    energy_total: { label: 'Lifetime energy from power', help: 'A kWh total that only goes up. Set a starting value to match a meter.', many: true, energy: true, start: true },
    counter_today: { label: 'Today’s increase of a counter', help: 'How much a lifetime counter (e.g. total kWh) went up since midnight.', single: true }
  };
  // Sums and averages can be shown split into their parts on cards; each part can be renamed.
  var SPLITTABLE = { sum: true, mean: true, weighted_mean: true };
  var state = { defs: [], status: {}, metrics: [], editing: null, autoLabels: {} };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) } : { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Server error ' + r.status)); return d; }); });
  }
  function fmt(v, unit) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v), d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
    if (unit === 'W' && a >= 1000) return (v / 1000).toFixed(2) + ' kW';
    return Number(v).toFixed(d) + (unit ? ' ' + unit : '');
  }
  function unitOf(name) { var m = state.metrics.find(function (x) { return x.name === name; }); return m && m.unit ? m.unit : ''; }

  function load() {
    return Promise.all([api('/api/combined-metrics'), api('/api/metrics/list')]).then(function (r) {
      state.defs = r[0].definitions || []; state.status = r[0].status || {}; state.autoLabels = r[0].auto_labels || {};
      state.metrics = (Array.isArray(r[1]) ? r[1] : []).map(function (m) { return typeof m === 'string' ? { name: m } : m; }).filter(function (m) { return m && m.name; });
      renderList(); renderSuggestions();
    }).catch(function (e) { $('cm-list').innerHTML = '<p class="st-help is-error">Could not load combined metrics: ' + esc(e.message) + '</p>'; });
  }

  function summary(d) {
    var info = FN_INFO[d.fn] || { label: d.fn };
    var n = (d.inputs || []).length;
    return info.label + ' · ' + (n === 1 ? esc(d.inputs[0]) : n + ' inputs');
  }
  function renderList() {
    var box = $('cm-list');
    if (!state.defs.length) { box.innerHTML = '<p class="st-help">None yet. Add one, or pick a suggestion above.</p>'; return; }
    box.innerHTML = state.defs.map(function (d, i) {
      var st = state.status[d.id] || null;
      var live = d.enabled === false ? '<span class="cm-state is-off">Off</span>'
        : !st ? '<span class="cm-state">Waiting for the next reading</span>'
        : st.ok ? '<span class="cm-state is-ok">' + esc(fmt(st.value, d.unit)) + '</span>'
        : '<span class="cm-state is-warn">Waiting: ' + esc(st.reason) + '</span>';
      return '<div class="cm-row" data-i="' + i + '">'
        + '<label class="toggle-switch" title="Compute this metric"><input type="checkbox" class="cm-enabled"' + (d.enabled === false ? '' : ' checked') + ' aria-label="Compute ' + esc(d.name) + '"><span class="slider"></span></label>'
        + '<div class="cm-main"><strong>' + esc(d.name) + '</strong>' + (d.unit ? ' <span class="cm-unit">' + esc(d.unit) + '</span>' : '') + '<span class="cm-sum">' + summary(d) + '</span></div>'
        + live
        + '<button type="button" class="st-btn cm-edit">Edit</button><button type="button" class="st-btn cm-del" aria-label="Delete ' + esc(d.name) + '">Delete</button></div>';
    }).join('');
  }

  // Suggestions from the metric names: several PV readings, loads, battery levels.
  function renderSuggestions() {
    // Only metrics that reported in the last hour: a listed name with no
    // readings would leave a sum waiting for ever.
    var now = Date.now() / 1000, recent = function (m) { var t = Number(m.timestamp); if (t > 1e12) t /= 1000; return t && now - t < 3600; };
    var box = $('cm-suggestions'), names = state.metrics.filter(recent).map(function (m) { return m.name; });
    var taken = {}; state.defs.forEach(function (d) { taken[d.name] = true; });
    var pick = function (re) { return names.filter(function (n) { return re.test(n) && !taken[n]; }); };
    var out = [];
    var pvTotals = pick(/(^|_)(pv|solar)_?(total_)?power$/i);
    var pvStrings = pick(/(^|_)pv\d+_power$/i);
    // One total per inverter beats adding its strings again (no double counting).
    var pv = pvTotals.length >= 2 ? pvTotals : (pvStrings.length >= 2 ? pvStrings : []);
    if (pv.length >= 2 && !taken.pv_total_power) out.push({ label: 'Total PV power from ' + pv.length + ' readings', def: { name: 'pv_total_power', unit: 'W', fn: 'sum', inputs: pv } });
    var loads = pick(/(^|_)(load|output|ac_output)_power$/i);
    if (loads.length >= 2 && !taken.load_total_power) out.push({ label: 'Total load from ' + loads.length + ' inverters', def: { name: 'load_total_power', unit: 'W', fn: 'sum', inputs: loads } });
    var socs = pick(/(^|_)battery_soc$/i);
    if (socs.length >= 2 && !taken.battery_soc_average) out.push({ label: 'Average battery charge from ' + socs.length + ' readings', def: { name: 'battery_soc_average', unit: '%', fn: 'mean', inputs: socs } });
    var pvSource = taken.pv_total_power || pv.length >= 2 ? 'pv_total_power' : (pvTotals[0] || null);
    if (pvSource && !taken.pv_energy_today) out.push({ label: 'Solar energy today from ' + pvSource, def: { name: 'pv_energy_today', unit: 'kWh', fn: 'energy_today', inputs: [pvSource], input_unit: 'W' } });
    // Drop suggestions an existing combined metric already covers (same inputs,
    // whatever it is called), and energy suggestions whose source doesn't exist.
    var covered = function (inputs) { return state.defs.some(function (d) { return (d.inputs || []).length && inputs.every(function (n) { return d.inputs.indexOf(n) !== -1; }); }); };
    var known = {}; state.metrics.forEach(function (m) { known[m.name] = true; }); state.defs.forEach(function (d) { known[d.name] = true; });
    // ...and kinds already done under another name (a PV total built from MPPT sums, say).
    var hasKind = function (fns, re) { return state.defs.some(function (d) { return fns.indexOf(d.fn) !== -1 && re.test(d.name); }); };
    var kindDone = { pv_total_power: hasKind(['sum'], /(pv|solar)/i), load_total_power: hasKind(['sum'], /(load|output|consumption)/i), battery_soc_average: hasKind(['mean', 'weighted_mean'], /(soc|charge)/i), pv_energy_today: hasKind(['energy_today', 'counter_today'], /(pv|solar)/i) };
    out = out.filter(function (o) { return !kindDone[o.def.name]; });
    out = out.filter(function (o) { return o.def.fn === 'energy_today' ? known[o.def.inputs[0]] && !state.defs.some(function (d) { return d.fn === 'energy_today' && d.inputs[0] === o.def.inputs[0]; }) : !covered(o.def.inputs); });
    box.hidden = !out.length;
    box.innerHTML = out.length ? '<p class="st-help">Suggested from your metrics:</p>' + out.map(function (s, i) { return '<button type="button" class="st-chip cm-suggest" data-s="' + i + '">' + esc(s.label) + '</button>'; }).join('') : '';
    box._suggestions = out;
  }

  // ── Editor ──────────────────────────────────────────────────────────────
  function openEditor(def, index) {
    state.editing = { index: index, def: JSON.parse(JSON.stringify(def || { name: '', unit: '', fn: 'sum', inputs: [], enabled: true })) };
    renderEditor();
    $('cm-editor').hidden = false;
    $('cm-name').focus();
  }
  function closeEditor() { state.editing = null; $('cm-editor').hidden = true; $('cm-editor').innerHTML = ''; }
  function renderEditor() {
    var d = state.editing.def, info = FN_INFO[d.fn] || FN_INFO.sum;
    var opts = Object.keys(FN_INFO).map(function (k) { return '<option value="' + k + '"' + (k === d.fn ? ' selected' : '') + '>' + esc(FN_INFO[k].label) + '</option>'; }).join('');
    var metricOpts = '<option value="">Add an input…</option>' + state.metrics.filter(function (m) { return m.name !== d.name && (d.inputs || []).indexOf(m.name) === -1; })
      .map(function (m) { return '<option value="' + esc(m.name) + '">' + esc(m.name) + (m.unit ? ' (' + esc(m.unit) + ')' : '') + '</option>'; }).join('');
    var auto = state.autoLabels[d.id || d.name] || {}, labels = d.labels || {};
    var inputs = (d.inputs || []).map(function (name, i) {
      return '<li class="cm-input" data-k="' + i + '"><span class="cm-input-name">' + (info.ordered && i === 0 ? '<em>From</em> ' : info.ordered ? '<em>minus</em> ' : '') + esc(name) + '</span>'
        + (SPLITTABLE[d.fn] ? '<input class="input cm-lbl" data-input="' + esc(name) + '" value="' + esc(labels[name] || '') + '" maxlength="40" placeholder="' + esc(auto[name] ? 'Shown as ' + auto[name] : 'Shown as (automatic)') + '" aria-label="Name shown on cards for ' + esc(name) + '">' : '')
        + (info.weights ? '<label class="cm-weight">Weight <input type="number" class="input cm-w" min="0" step="any" value="' + esc((d.weights || [])[i] == null ? 1 : d.weights[i]) + '"></label>' : '')
        + (info.ordered ? '<button type="button" class="st-btn cm-up" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' : '')
        + '<button type="button" class="st-btn cm-rm" aria-label="Remove ' + esc(name) + '">Remove</button></li>';
    }).join('');
    var full = (info.single && (d.inputs || []).length >= 1);
    $('cm-editor').innerHTML = '<h3>' + (state.editing.index == null ? 'New combined metric' : 'Edit ' + esc(d.name)) + '</h3>'
      + '<div class="st-grid-2"><div class="st-field"><label for="cm-name">Name</label><input id="cm-name" class="input" value="' + esc(d.name) + '" maxlength="64" placeholder="e.g. pv_total_power" autocomplete="off"></div>'
      + '<div class="st-field"><label for="cm-unit">Unit</label><input id="cm-unit" class="input" value="' + esc(d.unit || '') + '" maxlength="12" placeholder="e.g. W, kWh, %"></div></div>'
      + '<div class="st-field"><label for="cm-fn">Calculation</label><select id="cm-fn" class="input">' + opts + '</select><span class="st-help">' + esc(info.help) + '</span></div>'
      + '<div class="st-field"><span class="cm-label">Inputs</span>' + (SPLITTABLE[d.fn] ? '<span class="st-help">Cards set to show parts list each input by the name beside it. Leave it empty to use the name worked out from your sources.</span>' : '') + '<ol class="cm-inputs">' + (inputs || '<li class="st-help">No inputs yet.</li>') + '</ol>'
      + (full ? '' : '<select id="cm-add-input" class="input" aria-label="Add an input">' + metricOpts + '</select>'
        + (info.single ? '' : '<div class="cm-match"><input id="cm-match" class="input" placeholder="Add all that match, e.g. pv_power or inv*_pv1_power" aria-label="Add all metrics whose name matches" autocomplete="off"><button type="button" class="st-btn" id="cm-find">Find</button></div><div id="cm-matches" class="cm-matches" hidden></div>')) + '</div>'
      + (d.fn === 'scale' ? '<div class="st-grid-2"><div class="st-field"><label for="cm-factor">Factor</label><input id="cm-factor" class="input" type="number" step="any" value="' + esc(d.factor == null ? 1 : d.factor) + '"></div><div class="st-field"><label for="cm-offset">Offset</label><input id="cm-offset" class="input" type="number" step="any" value="' + esc(d.offset == null ? 0 : d.offset) + '"></div></div>' : '')
      + (info.energy ? '<div class="st-grid-2"><div class="st-field"><label for="cm-iu">Input power is in</label><select id="cm-iu" class="input"><option value="W"' + (d.input_unit !== 'kW' ? ' selected' : '') + '>W</option><option value="kW"' + (d.input_unit === 'kW' ? ' selected' : '') + '>kW</option></select></div>'
        + (info.start ? '<div class="st-field"><label for="cm-start">Start at (kWh)</label><input id="cm-start" class="input" type="number" step="any" min="0" value="' + esc(d.start == null ? 0 : d.start) + '"></div>' : '') + '</div>' : '')
      + '<details class="cm-more"><summary>When readings are late</summary><div class="st-grid-2">'
      + '<div class="st-field"><label for="cm-stale">Count a reading as late after (seconds)</label><input id="cm-stale" class="input" type="number" min="10" max="86400" value="' + esc(d.stale_seconds || 300) + '"></div>'
      + '<div class="st-field"><label for="cm-missing">If an input is late or missing</label><select id="cm-missing" class="input"><option value="skip"' + (d.missing !== 'zero' ? ' selected' : '') + '>Wait (don’t update)</option><option value="zero"' + (d.missing === 'zero' ? ' selected' : '') + '>Count it as 0</option></select></div></div></details>'
      + '<div class="cm-preview" id="cm-preview" role="status"></div>'
      + '<p class="st-help is-error" id="cm-error" role="alert" hidden></p>'
      + '<div class="st-inline-actions"><button type="button" class="st-btn" id="cm-try">Preview</button><span class="cm-spacer"></span><button type="button" class="st-btn" id="cm-cancel">Cancel</button><button type="button" class="st-btn st-btn-primary" id="cm-save">Save</button></div>';
  }
  // "Add all that match": part of a name, or a pattern with * (case-insensitive).
  function matchNames(text) {
    var q = String(text || '').trim(); if (!q) return [];
    var re;
    if (q.indexOf('*') !== -1) re = new RegExp('^' + q.split('*').map(function (p) { return p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }).join('.*') + '$', 'i');
    var d = state.editing.def, lower = q.toLowerCase();
    return state.metrics.filter(function (m) {
      if (m.name === d.name || (d.inputs || []).indexOf(m.name) !== -1) return false;
      return re ? re.test(m.name) : m.name.toLowerCase().indexOf(lower) !== -1;
    });
  }
  function isRecent(m) { var t = Number(m.timestamp); if (t > 1e12) t /= 1000; return t && Date.now() / 1000 - t < 3600; }
  function showMatches() {
    var box = $('cm-matches'); if (!box) return;
    var found = matchNames($('cm-match').value);
    box.hidden = false;
    if (!found.length) { box.innerHTML = '<p class="st-help">No other metrics match.</p>'; return; }
    box.innerHTML = '<p class="st-help">' + found.length + ' match' + (found.length === 1 ? '' : 'es') + '. Ones without a reading in the last hour are left unticked.</p>'
      + '<div class="cm-match-list">' + found.map(function (m) {
        return '<label class="cm-match-item"><input type="checkbox" class="cm-match-cb" value="' + esc(m.name) + '"' + (isRecent(m) ? ' checked' : '') + '> ' + esc(m.name)
          + (isRecent(m) ? ' <span class="cm-unit">' + esc(fmt(m.value, m.unit || '')) + '</span>' : ' <span class="cm-unit">no recent reading</span>') + '</label>';
      }).join('') + '</div><button type="button" class="st-btn st-btn-primary" id="cm-add-matches">Add ticked</button>';
  }

  function readEditor() {
    var d = state.editing.def, v = function (id) { var el = $(id); return el ? el.value : undefined; };
    d.name = (v('cm-name') || '').trim(); d.unit = (v('cm-unit') || '').trim();
    if ($('cm-factor')) { d.factor = Number(v('cm-factor')); d.offset = Number(v('cm-offset')); } else { delete d.factor; delete d.offset; }
    if ($('cm-iu')) d.input_unit = v('cm-iu'); else delete d.input_unit;
    if ($('cm-start')) d.start = Number(v('cm-start')); else delete d.start;
    if (FN_INFO[d.fn] && FN_INFO[d.fn].weights) d.weights = Array.from(document.querySelectorAll('#cm-editor .cm-w')).map(function (el) { return Number(el.value); }); else delete d.weights;
    d.stale_seconds = Number(v('cm-stale')) || 300; d.missing = v('cm-missing') || 'skip';
    var lbls = document.querySelectorAll('#cm-editor .cm-lbl');
    if (lbls.length) {
      var labels = {};
      Array.from(lbls).forEach(function (el) { var l = el.value.trim(); if (l && d.inputs.indexOf(el.dataset.input) !== -1) labels[el.dataset.input] = l; });
      if (Object.keys(labels).length) d.labels = labels; else delete d.labels;
    } else if (!SPLITTABLE[d.fn]) delete d.labels;
    return d;
  }
  // Outcome of list actions (switch on/off, delete), in the card's status line.
  function cardStatus(msg, type) {
    var el = $('cm-status'); if (!el) return;
    clearTimeout(el._t); el.textContent = msg; el.className = 'status ' + (type || '');
    if (type === 'success') el._t = setTimeout(function () { el.textContent = ''; el.className = 'status'; }, 5000);
  }
  function showError(msg) { var e = $('cm-error'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; }
  function saveAll(defs) {
    return api('/api/combined-metrics', { definitions: defs }).then(function (r) { state.defs = r.definitions || defs; renderList(); renderSuggestions(); return true; });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t || !t.closest('#combined-card')) return;
    var row = t.closest('.cm-row'), i = row ? Number(row.dataset.i) : null;
    if (t.id === 'cm-add') { openEditor(null, null); return; }
    if (t.classList.contains('cm-suggest')) { var s = $('cm-suggestions')._suggestions[Number(t.dataset.s)]; if (s) openEditor(s.def, null); return; }
    if (t.classList.contains('cm-edit')) { openEditor(state.defs[i], i); return; }
    if (t.classList.contains('cm-del')) {
      var name = state.defs[i].name;
      window.stConfirm({ message: 'Delete the combined metric "' + name + '"? Its past readings stay, but it is no longer worked out.' }).then(function (yes) {
        if (!yes) return;
        var next = state.defs.filter(function (d) { return d.name !== name; });
        saveAll(next).then(function () { cardStatus('Deleted ' + name + '.', 'success'); }).catch(function (err) { cardStatus(err.message, 'error'); });
      });
      return;
    }
    if (!state.editing) return;
    var d = state.editing.def;
    if (t.classList.contains('cm-rm')) { readEditor(); var k = Number(t.closest('.cm-input').dataset.k); d.inputs.splice(k, 1); if (d.weights) d.weights.splice(k, 1); renderEditor(); return; }
    if (t.classList.contains('cm-up')) { readEditor(); var j = Number(t.closest('.cm-input').dataset.k); d.inputs.splice(j - 1, 0, d.inputs.splice(j, 1)[0]); if (d.weights) d.weights.splice(j - 1, 0, d.weights.splice(j, 1)[0]); renderEditor(); return; }
    if (t.id === 'cm-cancel') { closeEditor(); return; }
    if (t.id === 'cm-find') { showMatches(); return; }
    if (t.id === 'cm-add-matches') {
      readEditor();
      var picked = Array.from(document.querySelectorAll('#cm-matches .cm-match-cb:checked')).map(function (cb) { return cb.value; });
      picked.forEach(function (n) { if (d.inputs.indexOf(n) === -1) { d.inputs.push(n); if (d.weights) d.weights.push(1); } });
      if (!d.unit && picked.length && !FN_INFO[d.fn].energy) d.unit = unitOf(picked[0]);
      renderEditor();
      return;
    }
    if (t.id === 'cm-try') {
      readEditor(); showError('');
      api('/api/combined-metrics/preview', d).then(function (r) {
        var lines = r.inputs.map(function (x) { return esc(x.name) + ': ' + (x.value == null ? 'no reading' : esc(fmt(x.value, unitOf(x.name))) + (x.age != null && x.age > (d.stale_seconds || 300) ? ' (late)' : '')); });
        $('cm-preview').innerHTML = '<p>' + lines.join(' · ') + '</p><p><strong>' + (r.skip ? 'Would wait: ' + esc(r.skip) : 'Result now: ' + esc(fmt(r.value, d.unit))) + '</strong>' + (r.note ? ' ' + esc(r.note) : '') + '</p>';
      }).catch(function (err) { showError(err.message); });
      return;
    }
    if (t.id === 'cm-save') {
      readEditor(); showError('');
      var defs = state.defs.slice();
      if (state.editing.index == null) defs.push(d); else defs[state.editing.index] = d;
      t.disabled = true;
      saveAll(defs).then(function () { closeEditor(); load(); }).catch(function (err) { showError(err.message); }).finally(function () { t.disabled = false; });
    }
  });
  document.addEventListener('change', function (e) {
    if (!e.target.closest('#combined-card')) return;
    if (e.target.classList.contains('cm-enabled')) {
      var i = Number(e.target.closest('.cm-row').dataset.i), defs = state.defs.slice();
      defs[i] = Object.assign({}, defs[i], { enabled: e.target.checked });
      saveAll(defs).then(function () { cardStatus(defs[i].name + (e.target.checked ? ' is computed again.' : ' is switched off.'), 'success'); }).catch(function (err) { cardStatus(err.message, 'error'); e.target.checked = !e.target.checked; });
      return;
    }
    if (!state.editing) return;
    var d = state.editing.def;
    if (e.target.id === 'cm-fn') { readEditor(); d.fn = e.target.value; if (FN_INFO[d.fn].single) d.inputs = d.inputs.slice(0, 1); if (FN_INFO[d.fn].energy && !d.unit) d.unit = 'kWh'; renderEditor(); return; }
    if (e.target.id === 'cm-add-input' && e.target.value) {
      readEditor(); d.inputs.push(e.target.value);
      if (d.weights) d.weights.push(1);
      if (!d.unit && !FN_INFO[d.fn].energy) d.unit = unitOf(e.target.value);
      renderEditor();
    }
  });

  // Enter in "Add all that match" searches (instead of saving the section).
  var cardEl = $('combined-card');
  if (cardEl) cardEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'cm-match') { e.preventDefault(); e.stopPropagation(); showMatches(); }
  });

  // Refresh live values while the Metrics section is open.
  setInterval(function () {
    var sec = document.getElementById('section-metrics');
    if (!sec || sec.hidden || state.editing) return;
    api('/api/combined-metrics').then(function (r) { state.status = r.status || {}; renderList(); }).catch(function () {});
  }, 30000);
  // Sources > "Combine readings": how many there are, and the link opens the card.
  function updateCallout() {
    var c = $('st-combine-count'); if (!c) return;
    var on = state.defs.filter(function (d) { return d.enabled !== false; }).length;
    c.textContent = state.defs.length ? (on + ' combined metric' + (on === 1 ? '' : 's') + ' in use.') : '';
  }
  document.addEventListener('click', function (e) {
    // Any link to Combined metrics (the Sources callout, Edit in All metrics) opens the card.
    if (!e.target.closest('a[href="#metrics/combined"]')) return;
    setTimeout(function () { var card = $('combined-card'); if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); var b = $('cm-add'); if (b) b.focus({ preventScroll: true }); } }, 150);
  });
  var baseRender = renderList;
  renderList = function () { baseRender(); updateCallout(); };
  if ($('combined-card')) load();
})();
