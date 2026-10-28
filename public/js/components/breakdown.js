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
    else out.push({ label, metric: p.metric, value: p.value });
  }
  return out;
}

/**
 * Rows for one node. `specs` lists the node's metrics in order, each
 * { name, unit?, format?(number, entry) }; those that are combined totals
 * contribute their parts, merged by label, so a battery node reads
 * "Phocos 1  52% · Charging 400 W". A metric used twice (charge and discharge on one
 * signed total) counts once. A spec with `power: 'charge' | 'discharge'` is a
 * battery's power: the charge and discharge of a part become ONE value, in words
 * ("Charging 1.21 kW", "Discharging 1.26 kW", "Idle") and a `tone` for its
 * colour, so every part reads the same whichever way it is going.
 * Returns [] when nothing on the node is combined.
 */
export function nodeRows(state, specs, depth = 'one') {
  const rows = new Map(), seen = new Set(), power = new Map();
  for (const spec of specs) {
    const total = spec && lookup(state, spec.name);
    if (!total || seen.has(total.name)) continue;
    seen.add(total.name);
    for (const part of flatten(total.parts, depth)) {
      // Energy parts come with today's kWh; other parts are read live.
      const entry = part.value != null ? { value: part.value, unit: total.unit } : state.metrics && state.metrics[part.metric];
      const n = Number(entry && entry.value);
      const unit = part.value != null ? total.unit : (entry && entry.unit) || total.unit || spec.unit || '';
      const known = entry && entry.value != null && Number.isFinite(n);
      if (!rows.has(part.label)) rows.set(part.label, []);
      if (spec.power) {
        // One slot per part, filled when every power spec has been read.
        if (!power.has(part.label)) { power.set(part.label, {}); rows.get(part.label).push({ power: part.label }); }
        power.get(part.label)[spec.power] = known ? n : null;
        continue;
      }
      rows.get(part.label).push(known ? (spec.format ? spec.format(n, entry) : formatMetric(n, unit).text) : '—');
    }
  }
  return [...rows].map(([label, values]) => {
    let tone;
    const texts = values.map(v => {
      if (!v || typeof v !== 'object') return v;
      const p = batteryPower(power.get(v.power));
      tone = p.tone;
      return p.text;
    });
    return tone ? { label, value: texts.join(' · '), tone } : { label, value: texts.join(' · ') };
  });
}

// Below this a battery is idle, not charging or discharging (watts).
const IDLE_W = 10;

/**
 * A battery part's charge and discharge as one reading. The charge value may be
 * signed (negative: discharging), as when one total carries both.
 */
export function batteryPower({ charge = null, discharge = null } = {}) {
  if (charge === null && discharge === null) return { text: '—' };
  const up = Math.max(0, charge ?? 0);
  const down = Math.max(0, -(charge ?? 0)) + Math.max(0, discharge ?? 0);
  const net = up - down;
  if (Math.abs(net) <= IDLE_W) return { text: 'Idle', tone: 'idle' };
  return net > 0
    ? { text: `Charging ${formatMetric(net, 'W').text}`, tone: 'charging' }
    : { text: `Discharging ${formatMetric(-net, 'W').text}`, tone: 'discharging' };
}

/**
 * Rows from a parts tree that already carries values ([{ label, value, parts? }]),
 * e.g. a table cell's parts: one level, or every level with labels joined.
 */
export function treeRows(parts, depth = 'one', format = n => formatMetric(n, 'kWh').text) {
  return flatten(parts, depth).map(p => ({ label: p.label, value: Number.isFinite(Number(p.value)) ? format(Number(p.value)) : '—' }));
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

/** Energy parts in the tile's own style: number only, the tile already says kWh. */
export const kwhFormat = (n) => `${n === 0 ? '0' : n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} kWh`;
export const socFormat = (n) => `${Math.round(n)}%`;
export const exportFormat = (n) => `${formatMetric(Math.abs(n), 'W').text} out`;

const rowsHtml = rows => rows.map(r => `<li${r.tone ? ` class="bd-${r.tone}"` : ''}><span class="bd-label">${escapeHtml(r.label)}</span><span class="bd-value">${escapeHtml(r.value)}</span></li>`).join('');

/**
 * Draw `rows` on `host` (the node element) in `mode`. `title` names the node
 * in the pop-up. Calling again updates in place; mode 'off' or no rows clears
 * everything this module added.
 */
export function renderBreakdown(host, rows, mode, title = '', before = null) {
  if (!host) return;
  let list = host.querySelector(':scope > .bd-list');
  const sr = host.querySelector(':scope > .bd-sr');
  if (mode !== 'inline' || !rows.length) { if (list) list.remove(); host.style.removeProperty('--bd-rows'); }
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
    host.style.setProperty('--bd-rows', String(rows.length));   // lets fixed-size layouts (e.g. a dial) make room
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
