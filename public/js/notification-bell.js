/**
 * The notification bell: recent alerts for a signed-in admin, newest first.
 *
 * A bell in the dashboard header with a count of unread alerts. Opening it lists what Epilykos has alerted
 * about (the same alerts sent to your phone, Telegram and so on), each with its severity, when it happened
 * and, for a problem that has since ended (grid back on, source answering again), a "Resolved" tag.
 * Clicking an alert marks it read and goes to the page it is about. Everything is drawn with textContent:
 * alert texts can contain anything a source reported.
 *
 * Only for a signed-in session (the server refuses /api/notifications otherwise); dashboard.js adds it
 * after the session check.
 */

const POLL_MS = 30000;
const SVG_NS = 'http://www.w3.org/2000/svg';

let bell = null, badge = null, panel = null, listEl = null, actionsEl = null;
let state = { items: [], unread: 0 };
let timer = null, open = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function icon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']) {
    const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.appendChild(p);
  }
  return svg;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" (a plain date after a week). */
export function ago(seconds, now = Date.now()) {
  const s = Math.max(0, Math.floor(now / 1000 - Number(seconds)));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
  return new Date(Number(seconds) * 1000).toLocaleDateString();
}

/** Only a path on this site is ever followed; anything else goes to the dashboard. */
export function safePath(path) {
  const p = String(path || '/');
  return p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') ? p : '/';
}

async function api(method, url, body) {
  const res = await fetch('/api/notifications' + url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function paintBadge() {
  const n = state.unread;
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  const worst = state.items.some(i => !i.read && i.severity === 'critical') ? 'critical' : 'normal';
  bell.dataset.level = worst;
  bell.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
}

function itemEl(item) {
  const row = el('button', 'notif-item');
  row.type = 'button';
  row.dataset.id = String(item.id);
  row.dataset.severity = item.severity || 'info';
  if (!item.read) row.classList.add('is-unread');
  if (item.resolved) row.classList.add('is-resolved');
  row.appendChild(el('span', 'notif-dot'));
  const text = el('span', 'notif-text');
  const head = el('span', 'notif-title-row');
  head.appendChild(el('span', 'notif-title', item.title || 'Alert'));
  if (item.resolved) head.appendChild(el('span', 'notif-tag', 'Resolved'));
  if (item.held) head.appendChild(el('span', 'notif-tag', 'Quiet hours'));
  text.appendChild(head);
  if (item.body) text.appendChild(el('span', 'notif-body', item.body));
  const time = el('span', 'notif-time', ago(item.timestamp));
  time.title = new Date(item.timestamp * 1000).toLocaleString();
  text.appendChild(time);
  row.appendChild(text);
  row.addEventListener('click', () => openItem(item));
  return row;
}

function paintPanel() {
  listEl.replaceChildren();
  if (!state.items.length) {
    const empty = el('div', 'notif-empty');
    empty.appendChild(el('strong', null, 'No alerts yet'));
    empty.appendChild(el('span', null, 'Alerts you set up under Settings → Notifications show up here, as well as on your phone.'));
    listEl.appendChild(empty);
  } else {
    for (const item of state.items) listEl.appendChild(itemEl(item));
  }
  actionsEl.querySelector('[data-act="read"]').disabled = state.unread === 0;
  actionsEl.querySelector('[data-act="clear"]').disabled = state.items.length === 0;
}

async function refresh() {
  try {
    state = await api('GET', '/inbox?limit=50');
    paintBadge();
    if (open) paintPanel();
  } catch (_) { /* signed out or offline: keep what is shown */ }
}

async function openItem(item) {
  if (!item.read) { api('POST', '/inbox/read', { ids: [item.id] }).catch(() => {}); }
  const target = new URL(safePath(item.path), window.location.origin);
  closePanel();
  if (target.pathname === window.location.pathname && !target.hash) return;   // already on the dashboard
  window.location.href = target.href;
}

function place() {
  const r = bell.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 16);
  panel.style.width = width + 'px';
  panel.style.top = Math.round(r.bottom + 8) + 'px';
  panel.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width)) + 'px';
}

function openPanel() {
  open = true;
  panel.hidden = false;
  bell.setAttribute('aria-expanded', 'true');
  place();
  paintPanel();
  refresh();
}
function closePanel() {
  open = false;
  panel.hidden = true;
  bell.setAttribute('aria-expanded', 'false');
}

function buildPanel() {
  panel = el('div', 'notif-panel');
  panel.id = 'notif-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Notifications');
  panel.hidden = true;
  const head = el('div', 'notif-head');
  head.appendChild(el('strong', null, 'Notifications'));
  actionsEl = el('span', 'notif-actions');
  const readAll = el('button', 'notif-link', 'Mark all read'); readAll.type = 'button'; readAll.dataset.act = 'read';
  const clear = el('button', 'notif-link', 'Clear'); clear.type = 'button'; clear.dataset.act = 'clear';
  actionsEl.append(readAll, clear);
  head.appendChild(actionsEl);
  listEl = el('div', 'notif-list');
  const foot = el('div', 'notif-foot');
  const manage = el('a', 'notif-link', 'Manage alerts'); manage.href = '/settings#notifications';
  foot.appendChild(manage);
  panel.append(head, listEl, foot);
  document.body.appendChild(panel);

  readAll.addEventListener('click', async () => {
    try { const r = await api('POST', '/inbox/read', { all: true }); state.unread = r.unread; state.items.forEach(i => { i.read = true; }); paintBadge(); paintPanel(); } catch (_) { /* try again */ }
  });
  clear.addEventListener('click', async () => {
    try { await api('DELETE', '/inbox'); state = { items: [], unread: 0 }; paintBadge(); paintPanel(); } catch (_) { /* try again */ }
  });
}

/** Add the bell in front of `before` (or at the end of `parent`); safe to call twice. */
export function initNotificationBell(parent, before) {
  if (!parent || document.getElementById('notif-bell')) return;
  bell = el('button', 'notif-bell');
  bell.id = 'notif-bell'; bell.type = 'button';
  bell.setAttribute('aria-label', 'Notifications');
  bell.setAttribute('aria-haspopup', 'dialog'); bell.setAttribute('aria-expanded', 'false'); bell.setAttribute('aria-controls', 'notif-panel');
  bell.appendChild(icon());
  badge = el('span', 'notif-badge'); badge.hidden = true;
  bell.appendChild(badge);
  if (before && before.parentNode === parent) parent.insertBefore(bell, before); else parent.appendChild(bell);
  buildPanel();

  bell.addEventListener('click', () => { if (open) closePanel(); else openPanel(); });
  document.addEventListener('click', (e) => { if (open && !panel.contains(e.target) && !bell.contains(e.target)) closePanel(); });
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { closePanel(); bell.focus(); } });
  window.addEventListener('resize', () => { if (open) place(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}

export function stopNotificationBell() {
  if (timer) clearInterval(timer);
  timer = null;
}
