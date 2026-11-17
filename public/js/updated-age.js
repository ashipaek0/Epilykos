/**
 * "Updated 12 s ago" in the dashboard header: how old what you are looking at
 * is. The page shows the last saved copy the moment it opens, and updates
 * arrive every few seconds; this tells a quiet moment from a stale view.
 * Past two minutes it says to check the connection.
 */

const STALE_MS = 2 * 60 * 1000;

/** "Updated just now", "Updated 24 s ago", "Updated 5 min ago", "Updated 2 h ago". */
export function ageText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'Updated just now';
  if (s < 60) return `Updated ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Updated ${h} h ago`;
  return `Updated ${Math.floor(h / 24)} d ago`;
}

export function isStale(ms) { return ms >= STALE_MS; }

let at = 0;
let el = null;
let timer = null;

function element() {
  if (el && el.isConnected) return el;
  if (typeof document === 'undefined') return null;
  el = document.getElementById('updated-age');
  if (!el) {
    const host = document.querySelector('.header-right');
    if (!host) return null;
    el = document.createElement('span');
    el.id = 'updated-age';
    el.className = 'updated-age';
    host.insertBefore(el, host.firstChild);
  }
  return el;
}

function render() {
  const node = element();
  if (!node || !at) return;
  // The System overview card already shows its own "Last updated"; one is enough.
  node.hidden = Boolean(document.querySelector('.so-updated'));
  const age = Date.now() - at;
  const stale = isStale(age);
  node.textContent = ageText(age) + (stale ? ' · check the connection' : '');
  node.classList.toggle('is-stale', stale);
  node.title = 'Last data received ' + new Date(at).toLocaleString();
}

/** The page just received data (or, with `when`, data that was received then; 0 means a saved copy of unknown age: say nothing). */
export function markFresh(when) {
  if (when === 0) return;
  const t = Number.isFinite(when) ? when : Date.now();
  if (t > at) at = t;
  render();
  if (!timer && typeof setInterval === 'function') {
    timer = setInterval(render, 1000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', render);
  }
}
