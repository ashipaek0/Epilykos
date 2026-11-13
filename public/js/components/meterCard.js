/**
 * Meter card card (type key `meter-card`): a label, a big value and a bar under it that fills as the reading (or another
 * reading) climbs towards a highest value, with up to two lines of words below. Made for "Made today 12.2 kWh" against
 * what is expected today, "Saved today" with the share from your own power, and a battery's charge with the power going
 * in and the energy stored.
 *
 * The bar is made of segments (or is one continuous bar when `segments` is 0). It fills from the bar metric (the value's own
 * metric when empty) between `min` and the highest value, which is a number or a metric (such as the forecast for today).
 * It can turn red below `lowAt` and amber below `warnAt` (percent of the bar), or keep one colour. The lines can hold
 * {value}, {max}, {pct} (how full the bar is, in percent) and the extra readings {a}, {b}, {c}. Every word is a setting,
 * so none is tied to a language.
 *
 * Block config: { label, metric, unit, prefix, decimals (0 to 3; empty: automatic), min, max, maxMetric, barMetric, segments, color, lowAt, warnAt,
 *   notes: [string, string], extras: [{ metric, unit, signed }] }
 *
 * @module components/meterCard
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';
import { decimalOpts, decimalsOption, extraOptions, extraValues, fillWords, hexColor, num, numberText, word } from './cardText.js';
import { fillBand } from './batteryCard.js';

export const MAX_SEGMENTS = 40;
export const DEFAULTS = Object.freeze({ metric: 'daily_solar', min: 0, max: 100, segments: 12 });

/** The valid options of a card's config. */
export function meterOptions(config = {}) {
  const min = num(config.min, DEFAULTS.min);
  let max = num(config.max, DEFAULTS.max);
  if (!(max > min)) max = min + 1;
  const lowAt = config.lowAt === '' || config.lowAt == null ? null : Math.max(0, Math.min(100, num(config.lowAt, 0)));
  const warnAt = config.warnAt === '' || config.warnAt == null ? null : Math.max(lowAt || 0, Math.min(100, num(config.warnAt, 0)));
  const notes = (Array.isArray(config.notes) ? config.notes : []).slice(0, 2).map(n => word(n, '', 120));
  return {
    label: word(config.label, '', 40), metric: word(config.metric, DEFAULTS.metric, 80), unit: word(config.unit, '', 12), prefix: word(config.prefix, '', 8), decimals: decimalsOption(config.decimals), min, max,
    maxMetric: word(config.maxMetric, '', 80), barMetric: word(config.barMetric, '', 80),
    segments: Math.max(0, Math.min(MAX_SEGMENTS, Math.round(num(config.segments, DEFAULTS.segments)))),
    color: hexColor(config.color), lowAt, warnAt, notes, extras: extraOptions(config.extras)
  };
}

/** How full the bar is, 0 to 1, or null when the reading is not a number. */
export function barFill(value, min, max) {
  if (!isNumericValue(value) || !(max > min)) return null;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** How many of `segments` are lit for a fill of 0 to 1: rounded to the nearest, and at least one for anything above zero. */
export function litSegments(fill, segments) {
  if (fill === null || !(segments > 0)) return 0;
  return Math.max(fill > 0 ? 1 : 0, Math.min(segments, Math.round(fill * segments)));
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

export function buildMeterCard(block = {}) {
  const o = meterOptions(block.config || {});
  const card = el('div', 'meter-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.meterCfg = JSON.stringify(o);
  if (o.color) card.style.setProperty('--mt-color', o.color);
  if (o.label) card.appendChild(el('div', 'mt-label', o.label));
  const main = el('div', 'mt-main');
  if (o.prefix) main.appendChild(el('span', 'mt-prefix', o.prefix));
  main.append(el('span', 'mt-value', '—'), el('span', 'mt-unit'));
  card.appendChild(main);
  const bar = el('div', o.segments ? 'mt-bar mt-segmented' : 'mt-bar');
  if (o.segments) { bar.style.setProperty('--mt-n', String(o.segments)); for (let i = 0; i < o.segments; i++) bar.appendChild(el('i', 'mt-seg')); }
  else bar.appendChild(el('i', 'mt-fill'));
  card.appendChild(bar);
  o.notes.forEach((n, i) => { if (n) card.appendChild(el('div', 'mt-note mt-note-' + i)); });
  return card;
}

export function updateMeterCard(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.meter-card').forEach(card => {
    let o; try { o = JSON.parse(card.dataset.meterCfg); } catch (e) { return; }
    const entry = metrics[o.metric], raw = entry ? entry.value : undefined;
    const unit = o.unit || (entry && entry.unit) || '';
    const shown = raw === undefined ? { value: '—', unit: '' } : formatMetric(raw, unit, decimalOpts(o.decimals));
    card.querySelector('.mt-value').textContent = shown.value;
    card.querySelector('.mt-unit').textContent = shown.unit;
    const maxEntry = o.maxMetric ? metrics[o.maxMetric] : undefined;
    const max = maxEntry && isNumericValue(maxEntry.value) && Number(maxEntry.value) > o.min ? Number(maxEntry.value) : o.max;
    const barEntry = o.barMetric ? metrics[o.barMetric] : entry;
    const fill = barFill(barEntry ? barEntry.value : undefined, o.min, max);
    const lit = litSegments(fill, o.segments);
    card.querySelectorAll('.mt-seg').forEach((s, i) => { s.dataset.on = i < lit ? '1' : '0'; });
    const solid = card.querySelector('.mt-fill');
    if (solid) solid.style.width = ((fill || 0) * 100).toFixed(1) + '%';
    card.dataset.band = o.lowAt === null && o.warnAt === null ? 'none' : fillBand(fill === null ? null : fill * 100, { lowAt: o.lowAt === null ? -1 : o.lowAt, warnAt: o.warnAt === null ? (o.lowAt === null ? -1 : o.lowAt) : o.warnAt });
    const values = { ...extraValues(o.extras, metrics), value: shown.unit ? `${shown.value} ${shown.unit}` : shown.value, max: numberText(max, unit, decimalOpts(o.decimals)).text, pct: fill === null ? '—' : String(Math.round(fill * 100)) };
    o.notes.forEach((n, i) => { const t = card.querySelector('.mt-note-' + i); if (t) t.textContent = fillWords(n, values); });
  });
}
