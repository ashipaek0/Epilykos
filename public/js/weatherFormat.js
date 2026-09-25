/**
 * Shared formatting for the weather + solar forecast cards.
 *
 * All helpers are null-safe: missing values render as '--' instead of
 * throwing (a REST source, for example, has no kWh totals or daily outlook).
 *
 * @module weatherFormat
 */
import { escapeHtml } from './utils.js';

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

export function fmtTemp(v) {
  const n = num(v);
  return n == null ? '--°' : `${Math.round(n)}°`;
}

export function fmtNum(v, digits = 0, suffix = '') {
  const n = num(v);
  return n == null ? '--' : `${n.toFixed(digits)}${suffix}`;
}

export function fmtKwh(v) {
  const n = num(v);
  return n == null ? '-- kWh' : `${n.toFixed(1)} kWh`;
}

/** 'YYYY-MM-DD' of `date` in the browser's local time. */
export function localDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'Today' / 'Tomorrow' / weekday for a 'YYYY-MM-DD' date. */
export function dayLabel(dateStr, style = 'long') {
  if (!dateStr) return '--';
  const today = localDate();
  const tomorrow = localDate(new Date(Date.now() + 86400000));
  if (dateStr === today) return 'Today';
  if (dateStr === tomorrow) return style === 'short' ? 'Tmrw' : 'Tomorrow';
  const d = new Date(dateStr + 'T12:00:00');
  return isNaN(d) ? dateStr : d.toLocaleDateString(undefined, { weekday: style });
}

/** Compact hour label for strips: '14' in 24-h locales, '2 PM' in 12-h ones. */
export function hourLabel(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (isNaN(d)) return '--';
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
}

export function timeLabel(iso, withMinutes = true) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (isNaN(d)) return '--';
  return withMinutes
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit' });
}

/** Coarse category for colouring an icon (see .wx-ic[data-kind] in style.css). */
export function weatherKind(code, isDay = true) {
  const c = num(code);
  if (c == null) return 'unknown';
  if (c <= 1) return isDay === false ? 'night' : 'clear';
  if (c === 2) return isDay === false ? 'night' : 'partly';
  if (c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  return 'rain';
}

/** Icon class for a WMO code when the payload carries no icon_class
 *  (e.g. Solcast periods); mirrors modules/solar.js WMO_CODES. */
export function iconForCode(code, isDay = true) {
  const kind = weatherKind(code, isDay);
  const c = num(code);
  const byKind = {
    clear: 'fi-sr-sun', night: c === 2 ? 'fi-sr-cloud-moon' : 'fi-sr-moon', partly: 'fi-sr-cloud-sun',
    cloudy: 'fi-sr-clouds', fog: 'fi-sr-fog', rain: 'fi-sr-cloud-rain', snow: 'fi-sr-cloud-snow',
    storm: 'fi-sr-thunderstorm', unknown: 'fi-sr-cloud'
  };
  return 'fi ' + byKind[kind];
}

/** Weather icon markup; falls back to a neutral cloud. */
export function iconHtml(iconClass, code, isDay, extraClass = '') {
  const cls = escapeHtml(iconClass || 'fi fi-sr-cloud');
  return `<i class="${cls} wx-ic ${extraClass}" data-kind="${weatherKind(code, isDay)}" aria-hidden="true"></i>`;
}

/** Wind as '3 m/s SW' (+ gusts when notably higher). */
export function fmtWind(speed, compass, gusts) {
  const s = num(speed);
  if (s == null) return '--';
  let out = `${s.toFixed(s < 10 ? 1 : 0)} m/s${compass ? ' ' + compass : ''}`;
  const g = num(gusts);
  if (g != null && g > s + 2) out += ` (gusts ${g.toFixed(0)})`;
  return out;
}

export function uvLabel(v) {
  const n = num(v);
  if (n == null) return '--';
  const band = n < 3 ? 'Low' : n < 6 ? 'Moderate' : n < 8 ? 'High' : n < 11 ? 'Very high' : 'Extreme';
  return `${n.toFixed(0)} ${band}`;
}
