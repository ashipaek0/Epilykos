/* Settings "Datum" look (see settings-datum.css; html.dt is set in settings.html).
 * Turns each .st-card into bands: a left column with the title and its help
 * text, a right column with the controls. Elements are moved, never cloned,
 * so every id, listener and form field keeps working. Cards that scripts
 * render later are wrapped as they appear. */
(function () {
  'use strict';

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

  run();
})();
