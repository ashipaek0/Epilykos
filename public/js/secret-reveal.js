/**
 * Keep sensitive values out of sight until asked, and let the person look at
 * them to check them.
 *
 *   Masked fields    every type="password" field, and the fields that identify
 *                    the site or the equipment (see SENSITIVE_FIELD): they show
 *                    dots, with an eye button to show what was typed.
 *   Masked displays  anything marked data-sensitive-display="key" (a sign-in
 *                    link or address with its QR code, say): blurred and not
 *                    selectable, with a Show button above it.
 *
 * Plain script, loaded by every page that has such a field. Fields and displays
 * that the page draws later are picked up as they appear. A field with its own
 * eye button (the setup wizard's password boxes) or `data-no-reveal` is left
 * alone. Whatever was revealed is hidden again after 30 seconds, when the tab
 * is left, and when a field's form is submitted.
 */
(function () {
  'use strict';

  var HIDE_AFTER_MS = 30000;

  // Fields that are not passwords but identify the site or the equipment: where it is,
  // which units and accounts it talks to. Matched against a field's name, id and data-field.
  var SENSITIVE_FIELD = new RegExp('(^|[^a-z])(' + [
    'latitude', 'longitude',
    'serial_number', 'dongle_serial', 'inverter_serial',
    'ble_address', 'bms_devices\\[\\d+\\]\\[address\\]', 'sources\\.bms[a-z]*\\.address',
    'dev_id', 'tuya-uid', 'local_key',
    'mqtt_devices\\[\\d+\\]\\[username\\]', 'sources\\.mqtt\\.username'
  ].join('|') + ')($|[^a-z])', 'i');

  var EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a10 10 0 004.4-1"/>'
    + '<path d="M9.9 9.9a3 3 0 004.2 4.2"/></svg>';

  /** What the field is called, for the button's label: its <label>, else its placeholder. */
  function nameOf(input) {
    var text = input.labels && input.labels[0] ? input.labels[0].textContent : '';
    text = (text || input.getAttribute('aria-label') || input.placeholder || '').replace(/\s+/g, ' ').trim();
    return text || 'value';
  }

  var MASKABLE = { text: 1, number: 1, tel: 1, search: 1, url: 1, email: 1 };

  function wanted(input) {
    if (input.type === 'password') return true;
    if (!MASKABLE[input.type]) return false;
    return SENSITIVE_FIELD.test([input.name, input.id, input.getAttribute('data-field')].join(' '));
  }

  function skip(input) {
    if (input.dataset.revealBound || input.hasAttribute('data-no-reveal')) return true;
    if (input.closest('[data-no-reveal]')) return true;
    var row = input.parentElement;
    return !!(row && row.querySelector(':scope > [data-action="reveal"]'));
  }

  // ── Fields ─────────────────────────────────────────────────────────────
  function enhance(input) {
    if (!wanted(input) || skip(input) || !input.parentNode) return;
    input.dataset.revealBound = '1';

    // A field that is not a password is shown as one while hidden, and gets its own type back when shown.
    // A number box is the exception: the browser empties it when what is in it is not a clean number
    // (6,5244 or 6.5244°), so it comes back as text.
    var shownType = input.type === 'password' || input.type === 'number' ? 'text' : input.type;
    if (input.type === 'number' && !input.hasAttribute('inputmode')) input.setAttribute('inputmode', 'decimal');
    if (input.type !== 'password') {
      input.type = 'password';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-1p-ignore', '');
    }

    var wrap = document.createElement('span');
    wrap.className = 'sr-wrap';
    if (input.style.maxWidth) wrap.style.maxWidth = input.style.maxWidth;
    // The wrapper takes the field's outer spacing so the eye lines up with the box itself.
    var cs = window.getComputedStyle(input);
    wrap.style.margin = cs.margin;
    input.style.margin = '0';
    if (cs.flexGrow !== '0') wrap.style.flex = cs.flex;
    if (cs.gridColumn && cs.gridColumn !== 'auto / auto') wrap.style.gridColumn = cs.gridColumn;
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sr-btn';
    wrap.appendChild(btn);

    // The page hides a field by hiding the input itself (style, class or hidden); the wrapper and
    // the eye must go with it.
    function followInput() {
      wrap.style.display = window.getComputedStyle(input).display === 'none' ? 'none' : '';
    }
    followInput();
    new MutationObserver(followInput).observe(input, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });

    var timer = null;
    function paint(shown) {
      btn.innerHTML = shown ? EYE_OFF : EYE;
      btn.setAttribute('aria-pressed', String(shown));
      btn.setAttribute('aria-label', (shown ? 'Hide ' : 'Show ') + nameOf(input));
      btn.title = shown ? 'Hide' : 'Show';
    }
    function set(shown) {
      input.type = shown ? shownType : 'password';
      paint(shown);
      clearTimeout(timer);
      if (shown) timer = setTimeout(function () { set(false); }, HIDE_AFTER_MS);
    }
    function isShown() { return input.type !== 'password'; }
    btn.addEventListener('click', function () { set(!isShown()); input.focus({ preventScroll: true }); });
    // Pressing the eye must not take focus (and blur) from the field.
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    input.addEventListener('input', function () { if (isShown()) { clearTimeout(timer); timer = setTimeout(function () { set(false); }, HIDE_AFTER_MS); } });
    if (input.form) input.form.addEventListener('submit', function () { if (isShown()) set(false); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && isShown()) set(false); });
    paint(false);
  }

  // ── Displays ───────────────────────────────────────────────────────────
  // A page that draws its status again every few seconds loses the element, so what is
  // shown is remembered by key: key → hide timer.
  var shownDisplays = {};

  function bindDisplay(box) {
    if (box.dataset.revealBound) return;
    box.dataset.revealBound = '1';
    var key = box.getAttribute('data-sensitive-display') || '';
    var what = box.getAttribute('data-sensitive-label') || 'this';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sr-toggle';
    var icon = document.createElement('span');
    var caption = document.createElement('span');
    btn.appendChild(icon);
    btn.appendChild(caption);
    box.parentNode.insertBefore(btn, box);

    function paint(shown) {
      icon.innerHTML = shown ? EYE_OFF : EYE;                    // fixed markup
      caption.textContent = (shown ? 'Hide ' : 'Show ') + what;    // text from the page, never markup
      btn.setAttribute('aria-pressed', String(shown));
      box.classList.toggle('sr-masked', !shown);
      box.inert = !shown;
      box.setAttribute('aria-hidden', String(!shown));
    }
    function set(shown) {
      paint(shown);
      if (key) {
        clearTimeout(shownDisplays[key]);
        if (shown) shownDisplays[key] = setTimeout(function () { delete shownDisplays[key]; if (document.contains(box)) set(false); }, HIDE_AFTER_MS);
        else delete shownDisplays[key];
      }
    }
    btn.addEventListener('click', function () { set(box.classList.contains('sr-masked')); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && !box.classList.contains('sr-masked') && document.contains(box)) set(false); });
    paint(!!(key && key in shownDisplays));
  }

  // Fields are handled once the page has finished drawing and labelling them (the settings page
  // wraps each device field in a label of its own), so the eye wraps the final field.
  var pending = [], flushTimer = null;
  function later(input) {
    pending.push(input);
    if (flushTimer === null) flushTimer = setTimeout(function () {
      var list = pending; pending = []; flushTimer = null;
      for (var i = 0; i < list.length; i++) enhance(list[i]);
    }, 0);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches) {
      if (root.matches('input')) later(root);
      if (root.matches('[data-sensitive-display]')) bindDisplay(root);
    }
    if (!root.querySelectorAll) return;
    var inputs = root.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) later(inputs[i]);
    var boxes = root.querySelectorAll('[data-sensitive-display]');
    for (var j = 0; j < boxes.length; j++) bindDisplay(boxes[j]);
  }

  function start() {
    scan(document.body);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) scan(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.secretReveal = { scan: scan, SENSITIVE_FIELD: SENSITIVE_FIELD, flush: function () { var l = pending; pending = []; clearTimeout(flushTimer); flushTimer = null; l.forEach(enhance); } };
})();
