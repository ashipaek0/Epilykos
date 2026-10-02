/**
 * One way to show a metric value on every card.
 *
 *   formatMetric(1460.4, 'W')   → { value: '1.46', unit: 'kW', text: '1.46 kW' }
 *   formatMetric(46.71, '%')    → { value: '47',   unit: '%',  text: '47 %' }
 *   formatMetric(16.776, 'kWh') → { value: '16.8', unit: 'kWh', text: '16.8 kWh' }
 *   formatMetric('Charging')    → { value: 'Charging', unit: '', text: 'Charging' }
 *   formatMetric(null)          → { value: '—', unit: '', text: '—', empty: true }
 *
 * Watts and watt-hours switch to kW / kWh from 1000 up. Decimals follow the
 * magnitude (more for small numbers) unless `decimals` is given. Numbers use
 * the browser's locale for grouping.
 *
 * @module components/format
 */
import { isNumericValue, formatValueText } from '../utils.js';

export const EMPTY = '—';

const nfCache = new Map();
function nf(decimals) {
  const key = String(decimals);
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  return nfCache.get(key);
}

/** Decimals that suit a number's size: 2 below 10, 1 below 100, else 0. */
function autoDecimals(n) {
  const a = Math.abs(n);
  if (a === 0) return 0;
  if (a < 10) return 2;
  if (a < 100) return 1;
  return 0;
}

/** Best-effort unit for a metric name, used when neither config nor data gives one. */
export function inferUnit(metricName) {
  const n = (metricName || '').toLowerCase();
  if (/soc|percentage|percent/.test(n)) return '%';
  if (/temp/.test(n)) return '°C';
  if (/volt/.test(n)) return 'V';
  if (/current|amp/.test(n)) return 'A';
  if (/daily|energy|kwh|_wh\b/.test(n)) return 'kWh';
  if (/power|watt|solar|consumption|load|grid_import|grid_export|charge/.test(n)) return 'W';
  if (/freq|hz/.test(n)) return 'Hz';
  if (/runtime/.test(n)) return 'h';
  return '';
}

/**
 * @param {*} raw - metric value (number, string, boolean, null)
 * @param {string} [unit] - unit to show; 'W' and 'Wh' scale up automatically
 * @param {{decimals?: number}} [opts]
 */
export function formatMetric(raw, unit, opts = {}) {
  const u = String(unit || '').trim();
  if (!isNumericValue(raw)) {
    const text = formatValueText(raw);
    if (text === '--') return { value: EMPTY, unit: '', text: EMPTY, empty: true };
    return { value: text, unit: u, text: u ? text + ' ' + u : text, empty: false, isText: true };
  }
  let n = raw, outUnit = u, decimals;
  if ((u === 'W' || u === 'Wh') && Math.abs(n) >= 1000) { n = n / 1000; outUnit = 'k' + u; }
  if (opts.decimals != null) decimals = opts.decimals;
  else if (outUnit === '%') decimals = Math.abs(n) < 10 && n % 1 !== 0 ? 1 : 0;
  else if (outUnit === 'W' || outUnit === 'Wh') decimals = 0;
  else if (outUnit === 'V' || outUnit === '°C' || outUnit === '°F' || outUnit === 'Hz') decimals = Math.abs(n) >= 100 ? 0 : 1;
  else decimals = autoDecimals(n);
  // Avoid "-0" when a small negative rounds to zero.
  const value = nf(decimals).format(Number(n.toFixed(decimals)) === 0 ? 0 : n);
  return { value, unit: outUnit, text: outUnit ? value + ' ' + outUnit : value, empty: false };
}

/** formatMetric for a state.metrics entry, resolving the unit (config → data → name). */
export function formatEntry(entry, configUnit, metricName, opts) {
  const unit = configUnit || entry?.unit || (isNumericValue(entry?.value) ? inferUnit(metricName) : '');
  return formatMetric(entry?.value, unit, opts);
}

/** Put a formatted value into an element as value + smaller unit. */
export function renderValue(el, formatted) {
  if (!el) return;
  el.textContent = '';
  const v = document.createElement('span');
  v.className = 'ep-num';
  v.textContent = formatted.value;
  el.appendChild(v);
  if (formatted.unit) {
    const u = document.createElement('span');
    u.className = 'ep-unit';
    u.textContent = formatted.unit;
    el.appendChild(u);
  }
  el.classList.toggle('is-empty', !!formatted.empty);
  el.classList.toggle('is-text', !!formatted.isText);
}

/** Hours as "3 h 12 min", "45 min" or "0 min". */
export function formatDuration(hours) {
  const total = Math.max(0, Math.round((Number(hours) || 0) * 60));
  const h = Math.floor(total / 60), m = total % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

/** Money: two decimals below 100, whole numbers above. */
export function formatMoney(value, currency) {
  if (!isNumericValue(value)) return EMPTY;
  const decimals = Math.abs(value) < 100 ? 2 : 0;
  return (currency || '') + nf(decimals).format(value);
}
