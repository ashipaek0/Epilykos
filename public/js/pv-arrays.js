/**
 * Settings > Forecast > Panels: one row per PV array (name, kWp, tilt,
 * direction, optional Solcast resource ID).
 *
 * The rows write the hidden `solar_arrays` field (JSON), and keep the older
 * single-array fields in step (`solar_capacity_kwp` = total kWp, tilt and
 * azimuth = the first array), so the save bar and everything that reads the
 * system capacity keep working. modules/solar.js forecasts each array and
 * adds them up.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var COMPASS = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'];
  function compass(deg) { var d = Number(deg); if (!isFinite(d)) return ''; return COMPASS[Math.round((((d % 360) + 360) % 360) / 45) % 8]; }
  var arrays = [];

  function readSaved() {
    var raw = $('solar-arrays') ? $('solar-arrays').value : '';
    var list = [];
    try { list = JSON.parse(raw || '[]'); } catch (_) { list = []; }
    if (!Array.isArray(list) || !list.length) {
      // No list yet: start from the single array saved before arrays existed.
      var kwp = Number($('solar-capacity') && $('solar-capacity').value);
      list = [{ name: 'Main array', kwp: kwp > 0 ? kwp : '', tilt: Number($('solar-tilt').value) || 30, azimuth: Number($('solar-azimuth').value) || 180, solcast_resource_id: '' }];
    }
    return list;
  }

  function write() {
    var clean = arrays.map(function (a, i) {
      return { name: String(a.name || '').trim() || ('Array ' + (i + 1)), kwp: Number(a.kwp) || 0, tilt: Number(a.tilt), azimuth: Number(a.azimuth), solcast_resource_id: String(a.solcast_resource_id || '').trim() };
    });
    var total = clean.reduce(function (s, a) { return s + (a.kwp > 0 ? a.kwp : 0); }, 0);
    var set = function (id, v) { var el = $(id); if (el && el.value !== String(v)) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('solar-arrays', JSON.stringify(clean));
    set('solar-capacity', total ? +total.toFixed(3) : '');
    if (clean[0]) { set('solar-tilt', isFinite(clean[0].tilt) ? clean[0].tilt : 30); set('solar-azimuth', isFinite(clean[0].azimuth) ? clean[0].azimuth : 180); }
    var t = $('pv-total'); if (t) t.textContent = clean.length > 1 ? 'Total ' + (+total.toFixed(2)) + ' kWp in ' + clean.length + ' arrays' : '';
  }

  function render() {
    var box = $('pv-arrays'); if (!box) return;
    box.innerHTML = arrays.map(function (a, i) {
      return '<div class="pv-array" data-i="' + i + '">'
        + '<div class="pv-array-head"><input class="input pv-name" aria-label="Array name" value="' + esc(a.name) + '" placeholder="e.g. East roof" maxlength="40">'
        + (arrays.length > 1 ? '<button type="button" class="st-btn pv-remove" aria-label="Remove ' + esc(a.name || 'array') + '">Remove</button>' : '') + '</div>'
        + '<div class="pv-array-grid">'
        + '<div class="st-field"><label>Peak capacity</label><div class="st-input-unit"><input class="input pv-kwp" type="number" min="0" step="any" value="' + esc(a.kwp) + '" inputmode="decimal"><span>kWp</span></div></div>'
        + '<div class="st-field"><label>Tilt</label><div class="st-input-unit"><input class="input pv-tilt" type="number" min="0" max="90" step="any" value="' + esc(a.tilt) + '"><span>°</span></div><span class="st-help">0° flat, 90° vertical.</span></div>'
        + '<div class="st-field"><label>Facing</label><div class="st-input-unit"><input class="input pv-az" type="number" min="0" max="360" step="any" value="' + esc(a.azimuth) + '"><span>°</span></div><span class="st-help pv-compass">' + esc(compass(a.azimuth)) + ' (180° is south, 90° east)</span></div>'
        + '<div class="st-field"><label>Solcast resource ID</label><input class="input pv-rid" value="' + esc(a.solcast_resource_id || '') + '" placeholder="Optional" autocomplete="off"></div>'
        + '</div></div>';
    }).join('') + '<p class="st-help" id="pv-total"></p>';
    write();
  }

  document.addEventListener('input', function (e) {
    var row = e.target.closest && e.target.closest('.pv-array'); if (!row) return;
    var a = arrays[Number(row.dataset.i)]; if (!a) return;
    if (e.target.classList.contains('pv-name')) a.name = e.target.value;
    else if (e.target.classList.contains('pv-kwp')) a.kwp = e.target.value;
    else if (e.target.classList.contains('pv-tilt')) a.tilt = e.target.value;
    else if (e.target.classList.contains('pv-az')) { a.azimuth = e.target.value; row.querySelector('.pv-compass').textContent = compass(a.azimuth) + ' (180° is south, 90° east)'; }
    else if (e.target.classList.contains('pv-rid')) a.solcast_resource_id = e.target.value;
    write();
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('#pv-add-array')) {
      var last = arrays[arrays.length - 1] || {};
      arrays.push({ name: 'Array ' + (arrays.length + 1), kwp: '', tilt: last.tilt != null ? last.tilt : 30, azimuth: last.azimuth != null ? last.azimuth : 180, solcast_resource_id: '' });
      render();
      var rows = document.querySelectorAll('#pv-arrays .pv-array'); var n = rows[rows.length - 1]; if (n) n.querySelector('.pv-kwp').focus();
      return;
    }
    var rm = e.target.closest('.pv-remove');
    if (rm) { arrays.splice(Number(rm.closest('.pv-array').dataset.i), 1); render(); }
  });

  function init() { arrays = readSaved(); render(); }
  // Discard restores the hidden fields and sends 'change' (our own writes send
  // 'input'), so rebuild the rows from what was saved.
  document.addEventListener('change', function (e) { if (e.target && e.target.id === 'solar-arrays') init(); });
  if (window.settingsReady && typeof window.settingsReady.then === 'function') window.settingsReady.then(init, init);
  else document.addEventListener('DOMContentLoaded', init);
})();
