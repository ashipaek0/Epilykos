/**
 * Shared by the System hero, Speedometer, Flow rows and Meter tile cards: words with values in them, and the few extra
 * readings ({a}, {b}, {c}) a card's words can use. Every word on those cards is a setting, so none is tied to a language;
 * a word can hold {value}, {max}, {pct} (as the card defines them) and {a}, {b}, {c} (the extra readings).
 *
 * @module components/cardText
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';

export const EXTRA_KEYS = ['a', 'b', 'c'];
export const hexColor = c => (/^#[0-9a-f]{3,8}$/i.test(String(c || '').trim()) ? String(c).trim() : '');
export const num = (v, fallback) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? fallback : n; };
/** A word from a setting: trimmed and limited, or `fallback` when empty. */
export const word = (v, fallback, max) => { const t = v == null ? '' : String(v).trim().slice(0, max); return t || fallback; };
/** The decimals setting: a whole number from 0 to 3, or null for the usual automatic choice. */
export const decimalsOption = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(3, Math.round(Number(v)))));
/** formatMetric's options for a decimals setting. */
export const decimalOpts = d => (d == null ? {} : { decimals: d });

/** Only web addresses and paths on this server can be used as a picture. */
export const imageUrl = v => { const t = String(v || '').trim().slice(0, 500); return /^(https?:)?\/\//i.test(t) || (t.charAt(0) === '/' && t.charAt(1) !== '/') ? t : ''; };

/** The valid extra readings of a config: up to three, each with a metric, a unit and whether to show a + for positive values. */
export function extraOptions(list) {
  return (Array.isArray(list) ? list : []).slice(0, EXTRA_KEYS.length)
    .map(e => ({ metric: String((e && e.metric) || '').trim(), unit: String((e && e.unit) || '').trim().slice(0, 12), signed: !!(e && (e.signed === true || e.signed === 'true')) }));
}

/** Format a reading for a word: with its unit, and a + for a positive value when `signed`. */
export function readingText(entry, unit, signed) {
  if (!entry) return '—';
  const u = unit || entry.unit || '';
  // A count (16 panels) has no decimals; the automatic choice would write 16.0.
  const whole = !u && isNumericValue(entry.value) && Number.isInteger(Number(entry.value));
  const text = formatMetric(entry.value, u, whole ? { decimals: 0 } : {}).text;
  return signed && isNumericValue(entry.value) && Number(entry.value) > 0 ? '+' + text : text;
}

/** {a}, {b}, {c} for the extra readings: text for each, '—' when the metric has no reading. */
export function extraValues(extras, metrics) {
  const out = {};
  EXTRA_KEYS.forEach((k, i) => {
    const e = extras[i];
    out[k] = e && e.metric ? readingText((metrics || {})[e.metric], e.unit, e.signed) : '—';
  });
  return out;
}

/** Put values into a word: {name} becomes values[name]; a {name} the card does not define stays as written. */
export function fillWords(text, values) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
}

/** A number's text in the unit of another reading, so "4.2 kW of 6.4" does not repeat the unit: { text } of `n` in `unit`. */
export function numberText(n, unit, opts) { return isNumericValue(n) ? formatMetric(n, unit || '', opts || {}) : { value: '—', unit: '', text: '—' }; }
