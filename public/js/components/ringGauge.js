/**
 * Ring gauge card (type key `ring-gauge`): up to three concentric rings, each filling for one metric between its
 * lowest and highest value, with the first two metrics read out in the middle (and any third in a line below).
 * The classic use is solar production on the outer ring and consumption on the next one.
 *
 * Everything is sized from the card: the dial is a square SVG (a 0-100 box) in its own size container, and the
 * text follows the dial (cqmin), so the card scales to any size. Colours are plain #rrggbb values or, by default,
 * the dashboard's solar / home / battery colours.
 *
 * Block config: { title, icon, showTracks, rings: [{ label, metric, unit, min, max, color }] }
 *
 * @module components/ringGauge
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';
import { tileIcon } from './tileIcon.js';

export const MAX_RINGS = 3;
export const DEFAULT_RINGS = Object.freeze([
  { label: 'Production', metric: 'solar', unit: '', min: 0, max: 5000, color: '' },
  { label: 'Consumption', metric: 'consumption', unit: '', min: 0, max: 5000, color: '' }
]);
const PALETTE = ['var(--solar, #f59e0b)', 'var(--home, #38bdf8)', 'var(--battery, #22c55e)'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const hexColor = c => (/^#[0-9a-f]{3,8}$/i.test(String(c || '').trim()) ? String(c).trim() : '');
const num = (v, fallback) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? fallback : n; };

/** The valid options of a card's config: 1 to 3 rings, each with a metric, label, unit, range and colour. */
export function ringOptions(config = {}) {
  const raw = Array.isArray(config.rings) && config.rings.length ? config.rings : DEFAULT_RINGS;
  const rings = raw.slice(0, MAX_RINGS).map((r, i) => {
    const min = num(r && r.min, 0);
    let max = num(r && r.max, 100);
    if (!(max > min)) max = min + 1;
    return {
      label: String((r && r.label) ?? '').trim().slice(0, 30), metric: String((r && r.metric) || '').trim(),
      unit: String((r && r.unit) || '').trim().slice(0, 12), min, max, color: hexColor(r && r.color) || PALETTE[i]
    };
  });
  return { title: String(config.title || '').trim().slice(0, 60), icon: String(config.icon || '').trim().slice(0, 200), showTracks: config.showTracks !== false, rings };
}

/** How full a ring is, 0 to 1, or null when the value is not a number. */
export function ringFraction(value, min, max) {
  if (!isNumericValue(value) || !(max > min)) return null;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Ring i's radius in the 0-100 box: the outer ring first, 9 units apart. */
export const ringRadius = i => 45 - i * 9;
export const RING_WIDTH = 6;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function buildRingGauge(block = {}) {
  const options = ringOptions(block.config || {});
  const card = el('div', `ring-gauge-card ep-card rg-n${options.rings.length}`);
  card.dataset.blockId = block.id || '';
  card.dataset.ringCfg = JSON.stringify(options);
  if (options.title) card.appendChild(el('div', 'rg-title', options.title));
  const dial = el('div', 'rg-dial');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'rg-svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('aria-hidden', 'true');
  options.rings.forEach((ring, i) => {
    for (const cls of ['rg-track', 'rg-arc']) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', cls); c.setAttribute('cx', '50'); c.setAttribute('cy', '50'); c.setAttribute('r', String(ringRadius(i)));
      c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', String(RING_WIDTH)); c.setAttribute('pathLength', '100');
      c.setAttribute('transform', 'rotate(-90 50 50)');
      if (cls === 'rg-arc') { c.setAttribute('stroke-linecap', 'round'); c.setAttribute('stroke-dasharray', '0 100'); c.style.stroke = ring.color; c.dataset.ring = String(i); }
      else c.hidden = !options.showTracks;
      svg.appendChild(c);
    }
  });
  dial.appendChild(svg);
  const center = el('div', 'rg-center');
  if (options.icon) { const icon = tileIcon(options.icon); if (icon) { icon.classList.add('rg-icon'); center.appendChild(icon); } }
  options.rings.slice(0, 2).forEach((ring, i) => {
    if (i === 1) center.appendChild(el('div', 'rg-divider'));
    const read = el('div', `rg-read rg-read-${i}`);
    const label = el('span', 'rg-label', ring.label); if (i === 0) label.style.color = ring.color;
    const value = el('span', 'rg-value', '—'); if (i === 1) value.style.color = ring.color;
    read.append(label, value);
    center.appendChild(read);
  });
  dial.appendChild(center);
  card.appendChild(dial);
  const extra = options.rings.slice(2);
  if (extra.length) {
    const legend = el('div', 'rg-legend');
    extra.forEach((ring, k) => {
      const item = el('span', 'rg-leg-item'); item.dataset.ring = String(k + 2);
      const dot = el('i', 'rg-leg-dot'); dot.style.background = ring.color;
      item.append(dot, el('span', 'rg-leg-label', ring.label), el('b', 'rg-leg-value', '—'));
      legend.appendChild(item);
    });
    card.appendChild(legend);
  }
  return card;
}

export function updateRingGauge(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.ring-gauge-card').forEach(card => {
    let options; try { options = JSON.parse(card.dataset.ringCfg); } catch (e) { return; }
    options.rings.forEach((ring, i) => {
      const entry = ring.metric ? metrics[ring.metric] : undefined;
      const raw = entry ? entry.value : undefined;
      const frac = ringFraction(raw, ring.min, ring.max);
      const arc = card.querySelector(`.rg-arc[data-ring="${i}"]`);
      if (arc) {
        const len = frac == null ? 0 : frac * 100;
        arc.setAttribute('stroke-dasharray', `${len.toFixed(2)} 100`);
        arc.style.visibility = len < 0.4 ? 'hidden' : '';   // a zero-length round cap would still draw a dot
      }
      const text = raw === undefined ? '—' : formatMetric(raw, ring.unit || (entry && entry.unit) || '').text;
      const target = i < 2 ? card.querySelector(`.rg-read-${i} .rg-value`) : card.querySelector(`.rg-leg-item[data-ring="${i}"] .rg-leg-value`);
      if (target) target.textContent = text;
    });
  });
}
