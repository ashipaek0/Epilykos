/**
 * Speedometer card (type key `speedometer`): a dial with a needle for one metric between its lowest and highest value
 * (both written at the ends of the arc), the reading and "of <highest>" in the middle, a status in plain text at the right
 * of the title row, and a line of words under the dial such as "66% of system size" (the percentage in the accent colour).
 *
 * The status follows the first of its rules that is true, so it can say "Near today's peak" at that moment and something
 * else the rest of the day. A rule is "near today's peak" (the reading is at least a share of the peak, a metric that holds
 * today's peak, for example the "Highest today" combined metric), "at or above" or "below" a share of the highest value, or
 * "always" (the fallback). The highest value is a number or a metric (such as the system size). Statuses and the caption
 * can hold {value}, {max}, {peak}, {pct} (the reading as a % of the highest) and the extra readings {a}, {b}, {c}, which
 * can be text such as the time of the peak. Every word is a setting, so none is tied to a language.
 *
 * Block config: { title, metric, unit, decimals (0 to 3; empty: automatic), min, max, maxMetric, peakMetric, ofText, caption, color,
 *   statuses: [{ rule ('near-peak'|'above'|'below'|'always'), limit (percent), text, color }], extras: [{ metric, unit, signed }] }
 *   (older cards with nearText and nearPct still show their near-peak text)
 *
 * @module components/speedometer
 */
import { isNumericValue } from '../utils.js';
import { decimalOpts, decimalsOption, extraOptions, extraValues, fillWords, hexColor, num, numberText, word } from './cardText.js';
import { formatMetric } from './format.js';

export const SWEEP = 240;                 // degrees of the dial
export const START = 150;                 // where it starts, clockwise from three o'clock (the lower left)
export const DEFAULTS = Object.freeze({ metric: 'solar', min: 0, max: 5000, nearPct: 85 });
export const STATUS_RULES = ['near-peak', 'above', 'below', 'always'];
export const MAX_STATUSES = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The valid statuses of a card's config (a card from before statuses, with nearText, has that one). */
export function statusOptions(config = {}) {
  let list = Array.isArray(config.statuses) ? config.statuses : [];
  if (!list.length && word(config.nearText, '', 60)) list = [{ rule: 'near-peak', limit: config.nearPct, text: config.nearText }];
  return list.map(st => {
    const rule = STATUS_RULES.includes(st && st.rule) ? st.rule : 'near-peak';
    return { rule, limit: Math.max(0, Math.min(100, num(st && st.limit, rule === 'near-peak' ? DEFAULTS.nearPct : 50))), text: word(st && st.text, '', 60), color: hexColor(st && st.color) };
  }).filter(st => st.text).slice(0, MAX_STATUSES);
}

/** The first status whose rule is true, or null. `frac` is how far round the dial the value is (0 to 1, or null). */
export function activeStatus(statuses, { value, peak, frac }) {
  for (const st of statuses) {
    if (st.rule === 'always') return st;
    if (st.rule === 'near-peak' && nearPeak(value, peak, st.limit)) return st;
    if (st.rule === 'above' && frac !== null && frac * 100 >= st.limit) return st;
    if (st.rule === 'below' && frac !== null && frac * 100 < st.limit) return st;
  }
  return null;
}

/** The valid options of a card's config. */
export function speedometerOptions(config = {}) {
  const min = num(config.min, DEFAULTS.min);
  let max = num(config.max, DEFAULTS.max);
  if (!(max > min)) max = min + 1;
  return {
    title: word(config.title, '', 60), metric: word(config.metric, DEFAULTS.metric, 80), unit: word(config.unit, '', 12), min, max,
    maxMetric: word(config.maxMetric, '', 80), peakMetric: word(config.peakMetric, '', 80),
    statuses: statusOptions(config),
    decimals: decimalsOption(config.decimals), ofText: word(config.ofText, 'of', 16), caption: word(config.caption, '', 120), color: hexColor(config.color), extras: extraOptions(config.extras)
  };
}

/** How far round the dial the value is, 0 to 1, or null when it is not a number. */
export function dialFraction(value, min, max) {
  if (!isNumericValue(value) || !(max > min)) return null;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** True when the value is at least `pct` % of the peak (false without a usable peak). */
export function nearPeak(value, peak, pct) {
  return isNumericValue(value) && isNumericValue(peak) && peak > 0 && value >= peak * pct / 100;
}

/** Where the dial's ends and ticks sit, in the 0-100 box: point at `deg` (clockwise from three o'clock) on a circle of radius r. */
export const dialPoint = (deg, r, cx = 50, cy = 52) => ({ x: cx + r * Math.cos(deg * Math.PI / 180), y: cy + r * Math.sin(deg * Math.PI / 180) });

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const PCT_OPEN = '\u0001', PCT_CLOSE = '\u0002';
/** The line under the dial, with the percentage (and a % straight after it) in the accent colour. */
function setCaption(node, text) {
  node.textContent = '';
  for (const part of String(text).split(/(\u0001[^\u0002]*\u0002%?)/)) {
    if (!part) continue;
    if (part.charAt(0) === PCT_OPEN) node.appendChild(el('b', 'sp-hl', part.replace(/[\u0001\u0002]/g, '')));
    else node.appendChild(document.createTextNode(part));
  }
}
function svgEl(tag, attrs, cls) {
  const e = document.createElementNS(SVG_NS, tag);
  if (cls) e.setAttribute('class', cls);
  for (const k of Object.keys(attrs || {})) e.setAttribute(k, String(attrs[k]));
  return e;
}

export function buildSpeedometer(block = {}) {
  const o = speedometerOptions(block.config || {});
  const card = el('div', 'speedometer-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.speedCfg = JSON.stringify(o);
  if (o.title || o.statuses.length) {
    const head = el('div', 'sp-head');
    head.append(el('span', 'sp-title', o.title), el('span', 'sp-status'));
    card.appendChild(head);
  }
  const dial = el('div', 'sp-dial');
  const face = el('div', 'sp-face');
  const svg = svgEl('svg', { viewBox: '0 0 100 86', 'aria-hidden': 'true' }, 'sp-svg');
  const track = (cls) => svgEl('circle', { cx: 50, cy: 52, r: 36, fill: 'none', 'stroke-width': 7, pathLength: 100, 'stroke-linecap': 'round', transform: `rotate(${START} 50 52)` }, cls);
  const t = track('sp-track'); t.setAttribute('stroke-dasharray', `${SWEEP / 3.6} 100`);
  const a = track('sp-arc'); a.setAttribute('stroke-dasharray', '0 100'); if (o.color) a.style.stroke = o.color;
  svg.append(t, a);
  for (let i = 0; i <= 10; i++) {
    const deg = START + SWEEP * i / 10, p1 = dialPoint(deg, 29.5), p2 = dialPoint(deg, i % 5 === 0 ? 25 : 27);
    svg.appendChild(svgEl('line', { x1: p1.x.toFixed(2), y1: p1.y.toFixed(2), x2: p2.x.toFixed(2), y2: p2.y.toFixed(2), 'stroke-width': i % 5 === 0 ? 1 : 0.6 }, 'sp-tick'));
  }
  const needle = svgEl('g', {}, 'sp-needle');
  needle.appendChild(svgEl('line', { x1: 50, y1: 52, x2: 76, y2: 52, 'stroke-width': 1.6, 'stroke-linecap': 'round' }, 'sp-needle-line'));
  svg.append(needle, svgEl('circle', { cx: 50, cy: 52, r: 2.4 }, 'sp-hub'));
  face.appendChild(svg);
  const read = el('div', 'sp-read');
  const main = el('div', 'sp-main'); main.append(el('span', 'sp-value', '—'), el('span', 'sp-unit'));
  read.append(main, el('div', 'sp-of'));
  face.append(read, el('span', 'sp-end sp-end-min'), el('span', 'sp-end sp-end-max'));
  dial.appendChild(face);
  card.appendChild(dial);
  card.appendChild(el('div', 'sp-caption'));
  return card;
}

export function updateSpeedometer(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.speedometer-card').forEach(card => {
    let o; try { o = JSON.parse(card.dataset.speedCfg); } catch (e) { return; }
    const entry = metrics[o.metric], raw = entry ? entry.value : undefined;
    const unit = o.unit || (entry && entry.unit) || '';
    const maxEntry = o.maxMetric ? metrics[o.maxMetric] : undefined;
    const max = maxEntry && isNumericValue(maxEntry.value) && Number(maxEntry.value) > o.min ? Number(maxEntry.value) : o.max;
    const frac = dialFraction(raw, o.min, max);
    const arc = card.querySelector('.sp-arc'), needle = card.querySelector('.sp-needle');
    if (arc) { arc.setAttribute('stroke-dasharray', `${((frac || 0) * SWEEP / 3.6).toFixed(2)} 100`); arc.style.visibility = frac === null || frac * SWEEP / 3.6 < 0.4 ? 'hidden' : ''; }
    if (needle) needle.style.transform = `rotate(${START + (frac || 0) * SWEEP}deg)`;
    const shown = raw === undefined ? { value: '—', unit: '' } : formatMetric(raw, unit, decimalOpts(o.decimals));
    card.querySelector('.sp-value').textContent = shown.value;
    card.querySelector('.sp-unit').textContent = shown.unit;
    const maxText = numberText(max, unit, decimalOpts(o.decimals));
    card.querySelector('.sp-of').textContent = `${o.ofText} ${maxText.unit === shown.unit || !shown.unit ? maxText.value : maxText.text}`;
    const peakEntry = o.peakMetric ? metrics[o.peakMetric] : undefined;
    const peak = peakEntry ? Number(peakEntry.value) : undefined;
    const plain = {
      ...extraValues(o.extras, metrics), value: shown.text, max: maxText.text, peak: peakEntry ? numberText(peak, unit, decimalOpts(o.decimals)).text : '—',
      pct: frac === null ? '—' : String(Math.round(frac * 100))
    };
    const status = card.querySelector('.sp-status');
    if (status) {
      const st = activeStatus(o.statuses, { value: raw, peak, frac });
      status.textContent = st ? fillWords(st.text, plain) : '';
      status.dataset.rule = st ? st.rule : '';
      status.style.color = st && st.color ? st.color : '';
    }
    card.querySelector('.sp-end-min').textContent = numberText(o.min, unit, decimalOpts(o.decimals)).value;
    card.querySelector('.sp-end-max').textContent = maxText.value;
    setCaption(card.querySelector('.sp-caption'), o.caption ? fillWords(o.caption, { ...plain, pct: PCT_OPEN + plain.pct + PCT_CLOSE }) : '');
  });
}
