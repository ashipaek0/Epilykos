/* Settings "Datum" look (see settings-datum.css).
 * Adds body.dt, and turns each .st-card into bands: a left column with the
 * title and its help text, a right column with the controls. Elements are
 * moved, never cloned, so every id, listener and form field keeps working.
 * Cards that scripts render later are wrapped as they appear.
 *
 * ?look=classic switches the new look off (remembered), ?look=datum back on. */
(function () {
  'use strict';
  var KEY = 'epilykos-settings-look';

  function readPref() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('look'); } catch (e) {}
    if (q === 'classic' || q === 'datum') {
      try { localStorage.setItem(KEY, q); } catch (e) {}
      return q;
    }
    try { return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'datum'; } catch (e) { return 'datum'; }
  }
  var FONTS = [['inter', 'Inter'], ['jakarta', 'Plus Jakarta Sans'], ['public', 'Public Sans'], ['atkinson', 'Atkinson Hyperlegible'], ['plex', 'IBM Plex Sans'], ['manrope', 'Manrope (earlier)']];
  var BANDS = [['rules', 'Rules and marker'], ['tint', 'Tinted panels'], ['rail', 'Side rail']];
  var look = readPref();
  addLookSwitch();
  if (look === 'classic') return;
  document.documentElement.classList.add('dt');

  var root = document.getElementById('main-content') || document.body;
  var scheduled = false;
  var observer = new MutationObserver(schedule);

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () { scheduled = false; run(); }, 60);
  }

  function run() {
    observer.disconnect();
    try {
      document.querySelectorAll('.st-card').forEach(wrapCard);
    } finally {
      observer.observe(root, { childList: true, subtree: true });
    }
  }

  function isHead(el) { return el.classList && el.classList.contains('st-card-head'); }
  function isSub(el) { return el.classList && el.classList.contains('st-card-subhead'); }

  function flatten(card) {
    var out = [];
    Array.prototype.slice.call(card.children).forEach(function (k) {
      if (!k.classList.contains('dt-band')) { out.push(k); return; }
      k.querySelectorAll(':scope > .dt-anchor > *, :scope > .dt-stream > *').forEach(function (n) {
        if (n.classList.contains('dt-toolbar')) {
          Array.prototype.slice.call(n.children).forEach(function (c) { out.push(c); });
        } else out.push(n);
      });
    });
    return out;
  }

  function wrapCard(card) {
    if (card.closest('dialog')) return;
    var kids = Array.prototype.slice.call(card.children);
    if (!kids.length) return;
    if (kids.every(function (k) { return k.classList.contains('dt-band'); })) return;
    var nodes = flatten(card);

    var segs = [];
    var cur = { head: null, rest: [] };
    nodes.forEach(function (n) {
      if (isHead(n) || isSub(n)) {
        if (cur.head || cur.rest.length) segs.push(cur);
        cur = { head: n, rest: [] };
      } else cur.rest.push(n);
    });
    segs.push(cur);

    var frag = document.createDocumentFragment();
    segs.forEach(function (s) {
      var band = document.createElement('div');
      band.className = 'dt-band';
      var stream = document.createElement('div');
      stream.className = 'dt-stream';
      var anchor = null;

      if (s.head) {
        anchor = document.createElement('div');
        anchor.className = 'dt-anchor';
        var rest = s.rest.slice();
        if (isHead(s.head)) {
          var title = s.head.querySelector('h1, h2, h3');
          if (title) {
            anchor.appendChild(title);
            var extras = Array.prototype.slice.call(s.head.children);
            if (extras.length) {
              var bar = document.createElement('div');
              bar.className = 'dt-toolbar';
              extras.forEach(function (x) { bar.appendChild(x); });
              stream.appendChild(bar);
            }
          } else {
            anchor = null;
            stream.appendChild(s.head);
          }
        } else {
          anchor.appendChild(s.head);
        }
        if (anchor && rest.length && rest[0].tagName === 'P' && rest[0].classList.contains('st-help')) {
          anchor.appendChild(rest.shift());
        }
        rest.forEach(function (n) { stream.appendChild(n); });
      } else {
        s.rest.forEach(function (n) { stream.appendChild(n); });
      }

      if (anchor) band.appendChild(anchor); else band.classList.add('no-anchor');
      band.appendChild(stream);
      frag.appendChild(band);
    });

    card.textContent = '';
    card.appendChild(frag);
    card.classList.add('dt-card');
  }

  function pick(key, fallback, list) {
    var v = null;
    try { v = localStorage.getItem(key); } catch (e) {}
    return list.some(function (x) { return x[0] === v; }) ? v : fallback;
  }
  function addPreviewControls(nav) {
    var wrap = document.createElement('details');
    wrap.className = 'dt-preview';
    var sum = document.createElement('summary');
    sum.textContent = 'Preview options';
    wrap.appendChild(sum);
    var inner = document.createElement('div');
    inner.className = 'dt-preview-body';
    wrap.appendChild(inner);
    [['Typeface', 'epilykos-dt-font', FONTS, 'inter', 'data-dt-font'], ['Section style', 'epilykos-dt-bands', BANDS, 'rules', 'data-dt-bands']].forEach(function (c) {
      var label = document.createElement('label');
      label.textContent = c[0];
      var sel = document.createElement('select');
      c[2].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
      sel.value = pick(c[1], c[3], c[2]);
      sel.addEventListener('change', function () {
        document.documentElement.setAttribute(c[4], sel.value);
        try { localStorage.setItem(c[1], sel.value); } catch (e) {}
      });
      label.appendChild(sel);
      inner.appendChild(label);
    });
    nav.appendChild(wrap);
  }

  function addLookSwitch() {
    var nav = document.getElementById('st-nav');
    if (!nav || document.getElementById('dt-look')) return;
    var p = document.createElement('p');
    p.className = 'dt-look';
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'dt-look';
    b.textContent = look === 'classic' ? 'Try the new look' : 'Use the classic look';
    b.addEventListener('click', function () {
      try { localStorage.setItem(KEY, look === 'classic' ? 'datum' : 'classic'); } catch (e) {}
      location.reload();
    });
    p.appendChild(b);
    nav.appendChild(p);
    if (look !== 'classic') addPreviewControls(nav);
  }

  run();
})();
