/**
 * Device card (type key `device-card`): one device or group on one card. Every part is optional, so the same card makes
 * "Solar panels 1.5 kW, 56.9 kWh today", a battery with a charge bar and a "Discharging 1.8 kW" pill, an inverter with a
 * capacity bar, a Volts / Hz / Amps trio and "From grid / Today" rows, or a plain "Grid: Off" tile.
 *
 *   header   title and subtitle on the left, a picture or icon on the right
 *   value    a big reading (with a prefix and unit), a status pill and a line of words under it
 *   bar      fills with a reading between a lowest and a highest value (or the reading of another metric), with a caption
 *   stats    up to three small readings side by side (label above, value below)
 *   rows     up to six label / value rows; a row's label can have its own colour
 *
 * The pill follows the first status whose rule is true (a status with no metric always applies, so it can be the fallback).
 * Words (the line under the value, the caption, the pill) can hold {value}, {max}, {pct} and the extra readings {a}, {b}, {c}.
 * Every word is a setting, so none is tied to a language.
 *
 * Block config: { title, subtitle, icon, metric, unit, prefix, decimals, note, statuses: [{ metric, when, limit, text, color }],
 *   showBar, barMetric, min, max, maxMetric, color, lowAt, warnAt, barCaption,
 *   stats: [{ label, metric, unit, decimals }], rows: [{ label, metric, unit, decimals, color, signed }],
 *   extras: [{ metric, unit, signed }] }
 *
 * @module components/deviceCard
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';
import { decimalOpts, decimalsOption, extraOptions, extraValues, fillWords, hexColor, num, numberText, word } from './cardText.js';
import { isOn, WHEN } from './statusList.js';
import { fillBand } from './batteryCard.js';
import { tileIcon } from './tileIcon.js';

export const MAX_STATUSES = 6;
export const MAX_STATS = 3;
export const MAX_ROWS = 6;

const list = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);

/** The valid options of a card's config. */
export function deviceOptions(config = {}) {
  const min = num(config.min, 0);
  let max = num(config.max, 100);
  if (!(max > min)) max = min + 1;
  const lowAt = config.lowAt === '' || config.lowAt == null ? null : Math.max(0, Math.min(100, num(config.lowAt, 0)));
  const warnAt = config.warnAt === '' || config.warnAt == null ? null : Math.max(lowAt || 0, Math.min(100, num(config.warnAt, 0)));
  return {
    title: word(config.title, '', 60), subtitle: word(config.subtitle, '', 80), icon: word(config.icon, '', 500),
    metric: word(config.metric, '', 80), unit: word(config.unit, '', 12), prefix: word(config.prefix, '', 8), decimals: decimalsOption(config.decimals),
    note: word(config.note, '', 120),
    statuses: list(config.statuses, MAX_STATUSES)
      .map(s => ({ metric: word(s && s.metric, '', 80), when: WHEN.includes(s && s.when) ? s.when : 'on', limit: num(s && s.limit, 0), text: word(s && s.text, '', 60), color: hexColor(s && s.color) }))
      .filter(s => s.text),
    showBar: config.showBar === true || config.showBar === 'true',
    barMetric: word(config.barMetric, '', 80), min, max, maxMetric: word(config.maxMetric, '', 80),
    color: hexColor(config.color), lowAt, warnAt, barCaption: word(config.barCaption, '', 120),
    stats: list(config.stats, MAX_STATS).map(s => ({ label: word(s && s.label, '', 24), metric: word(s && s.metric, '', 80), unit: word(s && s.unit, '', 12), decimals: decimalsOption(s && s.decimals) })).filter(s => s.metric),
    rows: list(config.rows, MAX_ROWS).map(r => ({ label: word(r && r.label, '', 40), metric: word(r && r.metric, '', 80), unit: word(r && r.unit, '', 12), decimals: decimalsOption(r && r.decimals), color: hexColor(r && r.color), signed: !!(r && (r.signed === true || r.signed === 'true')) })).filter(r => r.metric),
    extras: extraOptions(config.extras)
  };
}

/** The first status whose rule is true for these metrics, or null. A status with no metric always applies. */
export function activeStatus(options, metrics) {
  for (const s of options.statuses) {
    if (!s.metric) return s;
    const entry = metrics ? metrics[s.metric] : undefined;
    if (entry && isOn(entry.value, s) === true) return s;
  }
  return null;
}

/** How full the bar is, 0 to 1, or null when the reading is not a number. */
export function barFill(value, min, max) {
  if (!isNumericValue(value) || !(max > min)) return null;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

/** Text for a reading: its unit from the setting or the metric, a + for positive when `signed`, '—' when there is none. */
function reading(entry, unit, decimals, signed) {
  if (!entry || entry.value === undefined || entry.value === null) return '—';
  const text = formatMetric(entry.value, unit || entry.unit || '', decimalOpts(decimals)).text;
  return signed && isNumericValue(entry.value) && Number(entry.value) > 0 ? '+' + text : text;
}

export function buildDeviceCard(block = {}) {
  const o = deviceOptions(block.config || {});
  const card = el('div', 'device-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.deviceCfg = JSON.stringify(o);
  if (o.color) card.style.setProperty('--dv-color', o.color);

  if (o.title || o.subtitle || o.icon) {
    const head = el('div', 'dv-head');
    const words = el('div', 'dv-words');
    if (o.title) words.appendChild(el('div', 'dv-title', o.title));
    if (o.subtitle) words.appendChild(el('div', 'dv-subtitle', o.subtitle));
    head.appendChild(words);
    const icon = o.icon ? tileIcon(o.icon) : null;
    if (icon) { icon.classList.add('dv-art'); head.appendChild(icon); }
    card.appendChild(head);
  }
  if (o.metric) {
    const main = el('div', 'dv-main');
    if (o.prefix) main.appendChild(el('span', 'dv-prefix', o.prefix));
    main.append(el('span', 'dv-value', '—'), el('span', 'dv-unit'));
    card.appendChild(main);
  }
  if (o.statuses.length) card.appendChild(el('div', 'dv-pill'));
  if (o.note) card.appendChild(el('div', 'dv-note'));
  if (o.showBar) {
    const bar = el('div', 'dv-bar');
    bar.appendChild(el('i', 'dv-fill'));
    card.appendChild(bar);
    if (o.barCaption) card.appendChild(el('div', 'dv-caption'));
  }
  if (o.stats.length) {
    const stats = el('div', 'dv-stats');
    stats.style.setProperty('--dv-n', String(o.stats.length));
    o.stats.forEach((s, i) => {
      const cell = el('div', 'dv-stat');
      cell.append(el('div', 'dv-stat-label', s.label || s.metric), el('div', 'dv-stat-value', '—'));
      cell.dataset.i = String(i);
      stats.appendChild(cell);
    });
    card.appendChild(stats);
  }
  if (o.rows.length) {
    const rows = el('div', 'dv-rows');
    o.rows.forEach((r, i) => {
      const row = el('div', 'dv-row');
      row.dataset.i = String(i);
      const label = el('span', 'dv-row-label', r.label || r.metric);
      if (r.color) label.style.color = r.color;
      row.append(label, el('span', 'dv-row-value', '—'));
      rows.appendChild(row);
    });
    card.appendChild(rows);
  }
  return card;
}

export function updateDeviceCard(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.device-card').forEach(card => {
    let o; try { o = JSON.parse(card.dataset.deviceCfg); } catch (e) { return; }
    const entry = o.metric ? metrics[o.metric] : undefined;
    const unit = o.unit || (entry && entry.unit) || '';
    const shown = !entry || entry.value === undefined ? { value: '—', unit: '' } : formatMetric(entry.value, unit, decimalOpts(o.decimals));

    const valueEl = card.querySelector('.dv-value');
    if (valueEl) { valueEl.textContent = shown.value; card.querySelector('.dv-unit').textContent = shown.unit; }

    const maxEntry = o.maxMetric ? metrics[o.maxMetric] : undefined;
    const max = maxEntry && isNumericValue(maxEntry.value) && Number(maxEntry.value) > o.min ? Number(maxEntry.value) : o.max;
    const barEntry = o.barMetric ? metrics[o.barMetric] : entry;
    const fill = barFill(barEntry ? barEntry.value : undefined, o.min, max);
    const values = {
      ...extraValues(o.extras, metrics),
      value: shown.unit ? `${shown.value} ${shown.unit}` : shown.value,
      max: numberText(max, unit, decimalOpts(o.decimals)).text,
      pct: fill === null ? '—' : String(Math.round(fill * 100))
    };

    const status = activeStatus(o, metrics);
    const pill = card.querySelector('.dv-pill');
    if (pill) {
      pill.textContent = status ? fillWords(status.text, values) : '';
      pill.style.setProperty('--dv-pill', (status && status.color) || '');
    }
    const note = card.querySelector('.dv-note');
    if (note) note.textContent = fillWords(o.note, values);

    const fillEl = card.querySelector('.dv-fill');
    if (fillEl) {
      fillEl.style.width = ((fill || 0) * 100).toFixed(1) + '%';
      card.dataset.band = o.lowAt === null && o.warnAt === null ? 'none'
        : fillBand(fill === null ? null : fill * 100, { lowAt: o.lowAt === null ? -1 : o.lowAt, warnAt: o.warnAt === null ? (o.lowAt === null ? -1 : o.lowAt) : o.warnAt });
      const caption = card.querySelector('.dv-caption');
      if (caption) caption.textContent = fillWords(o.barCaption, values);
    }
    card.querySelectorAll('.dv-stat').forEach(cell => {
      const s = o.stats[Number(cell.dataset.i)];
      if (s) cell.querySelector('.dv-stat-value').textContent = reading(metrics[s.metric], s.unit, s.decimals, false);
    });
    card.querySelectorAll('.dv-row').forEach(row => {
      const r = o.rows[Number(row.dataset.i)];
      if (r) row.querySelector('.dv-row-value').textContent = reading(metrics[r.metric], r.unit, r.decimals, r.signed);
    });
  });
}
