/**
 * Breakdown: the parts behind a combined total, shown on a card's nodes.
 *
 * The server sends `state.breakdowns` (modules/combinedMetrics.js
 * buildBreakdowns): each combined sum or average with its parts and short
 * labels, and which roles point at one. A card asks for the rows of a node
 * (nodeRows) and draws them (renderBreakdown) in one of three modes, set per
 * card as `config.breakdown`:
 *
 *   off     (default) only the total; nothing shows it is made of parts
 *   inline  the parts listed in small text under the node's value
 *   hover   the parts in a pop-up on hover, focus or tap
 *
 * `config.breakdown_depth` 'one' (default) lists the direct parts; 'all'
 * opens nested totals down to the last level (e.g. every MPPT of every
 * inverter rather than each inverter).
 *
 * @module components/breakdown
 */
import { escapeHtml } from '../utils.js';
import { formatMetric } from './format.js';

export function breakdownMode(config) {
  const m = config && config.breakdown;
  return m === 'inline' || m === 'hover' ? m : 'off';
}
export function breakdownDepth(config) { return config && config.breakdown_depth === 'all' ? 'all' : 'one'; }

/** The combined total behind a metric name or a role, or null. */
function lookup(state, name) {
  const b = state && state.breakdowns;
  if (!b || !b.metrics || !name) return null;
  if (b.metrics[name]) return { name, ...b.metrics[name] };
  const viaRole = b.roles && b.roles[name];
  return viaRole && b.metrics[viaRole] ? { name: viaRole, ...b.metrics[viaRole] } : null;
}

function flatten(parts, depth, parent) {
  const out = [];
  for (const p of parts || []) {
    const label = parent ? `${parent} ${p.label}` : p.label;
    if (depth === 'all' && Array.isArray(p.parts) && p.parts.length) out.push(...flatten(p.parts, depth, label));
    else out.push({ label, metric: p.metric });
  }
  return out;
}

/**
 * Rows for one node. `specs` lists the node's metrics in order, each
 * { name, unit?, format?(number, entry) }; those that are combined totals
 * contribute their parts, merged by label, so a battery node reads
 * "Phocos 1  52% · ↑ 400 W". A metric used twice (charge and discharge on one
 * signed total) counts once. Returns [] when nothing on the node is combined.
 */
export function nodeRows(state, specs, depth = 'one') {
  const rows = new Map(), seen = new Set();
  for (const spec of specs) {
    const total = spec && lookup(state, spec.name);
    if (!total || seen.has(total.name)) continue;
    seen.add(total.name);
    for (const part of flatten(total.parts, depth)) {
      const entry = state.metrics && state.metrics[part.metric];
      const n = Number(entry && entry.value);
      const unit = (entry && entry.unit) || total.unit || spec.unit || '';
      const text = entry && entry.value != null && Number.isFinite(n) ? (spec.format ? spec.format(n, entry) : formatMetric(n, unit).text) : '—';
      if (!rows.has(part.label)) rows.set(part.label, []);
      rows.get(part.label).push(text);
    }
  }
  return [...rows].map(([label, values]) => ({ label, value: values.join(' · ') }));
}

/** Keep the card's breakdown settings on its element, for the updater. */
export function markBreakdown(el, config) {
  el.dataset.breakdown = breakdownMode(config);
  el.dataset.breakdownDepth = breakdownDepth(config);
}

/**
 * Update every node of one card. nodes: [{ host, specs, title, before? }]
 * (`before`: put the inline list before this child, e.g. above a circle the
 * flow line leaves from).
 */
export function applyBreakdowns(card, state, nodes) {
  const mode = card.dataset.breakdown || 'off', depth = card.dataset.breakdownDepth || 'one';
  for (const n of nodes) {
    if (!n.host) continue;
    renderBreakdown(n.host, mode === 'off' ? [] : nodeRows(state, n.specs.filter(x => x && x.name), depth), mode, n.title, n.before);
  }
}

/** Battery power parts: arrows for charging and discharging. */
export const chargeFormat = (n) => `${n > 0 ? '↑ ' : n < 0 ? '↓ ' : ''}${formatMetric(Math.abs(n), 'W').text}`;
export const dischargeFormat = (n) => `${n > 0 ? '↓ ' : ''}${formatMetric(Math.abs(n), 'W').text}`;
export const socFormat = (n) => `${Math.round(n)}%`;
export const exportFormat = (n) => `${formatMetric(Math.abs(n), 'W').text} out`;

const rowsHtml = rows => rows.map(r => `<li><span class="bd-label">${escapeHtml(r.label)}</span><span class="bd-value">${escapeHtml(r.value)}</span></li>`).join('');

/**
 * Draw `rows` on `host` (the node element) in `mode`. `title` names the node
 * in the pop-up. Calling again updates in place; mode 'off' or no rows clears
 * everything this module added.
 */
export function renderBreakdown(host, rows, mode, title = '', before = null) {
  if (!host) return;
  let list = host.querySelector(':scope > .bd-list');
  const sr = host.querySelector(':scope > .bd-sr');
  if (mode !== 'inline' || !rows.length) { if (list) list.remove(); }
  if (mode !== 'hover' || !rows.length) {
    if (sr) sr.remove();
    if (host.classList.contains('bd-host')) {
      host.classList.remove('bd-host'); host.removeAttribute('tabindex'); host.removeAttribute('aria-expanded');
      delete host._bd;
      if (pop && pop._host === host) hide();
    }
  }
  if (!rows.length || mode === 'off') return;
  if (mode === 'inline') {
    if (!list) { list = document.createElement('ul'); list.className = 'bd-list'; host.insertBefore(list, before && before.parentNode === host ? before : null); }
    const html = rowsHtml(rows);
    if (list.innerHTML !== html) list.innerHTML = html;
    return;
  }
  // hover / focus / tap
  installPopover();
  host.classList.add('bd-host');
  if (!host.hasAttribute('tabindex')) host.setAttribute('tabindex', '0');
  host.setAttribute('aria-expanded', pop && pop._host === host ? 'true' : 'false');
  host._bd = { rows, title };
  let s = sr;
  if (!s) { s = document.createElement('span'); s.className = 'bd-sr sr-only'; host.appendChild(s); }
  s.textContent = rows.map(r => `${r.label} ${r.value}`).join(', ');
  if (pop && pop._host === host) fill(host);
}

// ── Shared pop-up ──────────────────────────────────────────────────────────
let pop = null, installed = false, lastPointer = '', shownAt = 0;

function fill(host) {
  const { rows, title } = host._bd || { rows: [] };
  pop.innerHTML = (title ? `<p class="bd-pop-title">${escapeHtml(title)}</p>` : '') + `<ul class="bd-list">${rowsHtml(rows)}</ul>`;
}
function show(host) {
  if (!host || !host._bd) return;
  if (!pop) { pop = document.createElement('div'); pop.className = 'bd-pop'; pop.setAttribute('role', 'tooltip'); pop.hidden = true; document.body.appendChild(pop); }
  if (pop._host && pop._host !== host) pop._host.setAttribute('aria-expanded', 'false');
  if (pop._host !== host || pop.hidden) shownAt = Date.now();
  pop._host = host; host.setAttribute('aria-expanded', 'true');
  fill(host);
  pop.hidden = false;
  const r = host.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, gap = 8;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const below = r.bottom + gap + h <= window.innerHeight - 8 || r.top - gap - h < 8;
  pop.style.left = `${Math.round(left + window.scrollX)}px`;
  pop.style.top = `${Math.round((below ? r.bottom + gap : r.top - gap - h) + window.scrollY)}px`;
}
function hide() {
  if (!pop || pop.hidden) return;
  if (pop._host) pop._host.setAttribute('aria-expanded', 'false');
  pop.hidden = true; pop._host = null;
}
function installPopover() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const hostOf = e => (e.target && e.target.closest ? e.target.closest('.bd-host') : null);
  document.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') { const h = hostOf(e); if (h) show(h); } });
  document.addEventListener('pointerout', e => {
    if (e.pointerType !== 'mouse') return;
    const h = hostOf(e); if (h && !(e.relatedTarget && h.contains(e.relatedTarget)) && pop && pop._host === h) hide();
  });
  document.addEventListener('pointerdown', e => { lastPointer = e.pointerType || ''; }, true);
  // Tap toggles. A tap also focuses the node (which opens it), so a click right
  // after opening keeps it open; mouse users have hover instead.
  document.addEventListener('click', e => {
    const h = hostOf(e);
    if (h) {
      if (lastPointer === 'mouse') return;
      if (pop && pop._host === h && !pop.hidden && Date.now() - shownAt > 400) hide(); else show(h);
    } else if (pop && !pop.contains(e.target)) hide();
  });
  document.addEventListener('focusin', e => { const h = hostOf(e); if (h) show(h); });
  document.addEventListener('focusout', e => { const h = hostOf(e); if (h && pop && pop._host === h) hide(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
}
