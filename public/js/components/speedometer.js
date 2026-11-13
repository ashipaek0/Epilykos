/**
 * Speedometer card (type key `speedometer`): a dial with a needle for one metric between its lowest and highest value,
 * the reading and "of <highest>" in the middle, a tag that lights while the reading is near today's peak, and a line of
 * words under the dial such as "66% of system size".
 *
 * The highest value is a number or a metric (such as the system size). The peak comes from a metric that holds today's
 * peak (for example the "Highest today" combined metric); with no peak metric the tag never shows. The caption can hold
 * {value}, {max}, {peak}, {pct} (the reading as a % of the highest) and the extra readings {a}, {b}, {c}, which can be
 * text such as the time of the peak. Every word is a setting, so none is tied to a language.
 *
 * Block config: { title, metric, unit, decimals (0 to 3; empty: automatic), min, max, maxMetric, peakMetric, nearPct, nearText, ofText, caption, color,
 *   extras: [{ metric, unit, signed }] }
 *
 * @module components/speedometer
 */
import { isNumericValue } from '../utils.js';
import { decimalOpts, decimalsOption, extraOptions, extraValues, fillWords, hexColor, num, numberText, word } from './cardText.js';
import { formatMetric } from './format.js';

export const SWEEP = 240;                 // degrees of the dial
export const START = 150;                 // where it starts, clockwise from three o'clock (the lower left)
export const DEFAULTS = Object.freeze({ metric: 'solar', min: 0, max: 5000, nearPct: 85 });
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The valid options of a card's config. */
export function speedometerOptions(config = {}) {
  const min = num(config.min, DEFAULTS.min);
  let max = num(config.max, DEFAULTS.max);
  if (!(max > min)) max = min + 1;
  return {
    title: word(config.title, '', 60), metric: word(config.metric, DEFAULTS.metric, 80), unit: word(config.unit, '', 12), min, max,
    maxMetric: word(config.maxMetric, '', 80), peakMetric: word(config.peakMetric, '', 80),
    nearPct: Math.max(1, Math.min(100, num(config.nearPct, DEFAULTS.nearPct))), nearText: word(config.nearText, '', 40),
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
  if (o.title) card.appendChild(el('div', 'sp-title', o.title));
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
  face.appendChild(read);
  dial.appendChild(face);
  card.appendChild(dial);
  card.append(el('div', 'sp-tag'), el('div', 'sp-caption'));
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
    const tag = card.querySelector('.sp-tag');
    const near = !!o.nearText && nearPeak(raw, peak, o.nearPct);
    tag.textContent = near ? o.nearText : ''; tag.hidden = !near;
    const values = {
      ...extraValues(o.extras, metrics), value: shown.text, max: maxText.text, peak: peakEntry ? numberText(peak, unit, decimalOpts(o.decimals)).text : '—',
      pct: frac === null ? '—' : String(Math.round(frac * 100))
    };
    card.querySelector('.sp-caption').textContent = o.caption ? fillWords(o.caption, values) : '';
  });
}
