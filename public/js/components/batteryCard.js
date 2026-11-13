/**
 * Battery card (type key `battery-card`): a battery that fills to the state of charge, with a charge scale beside it,
 * the charge in big type below, an optional vertical current marker (charging above zero, discharging below), and a
 * row of small readings (such as the inside and outside temperature) along the bottom.
 *
 * The fill colour follows the charge: red at or below `lowAt`, amber at or below `warnAt`, green above (or one
 * colour of your own). Everything is sized from the card (it is a size container; the battery and the marker are
 * sized from the body's height), so it works at any size.
 *
 * Block config: { title, metrics: { soc, current }, showCurrent, currentMax, lowAt, warnAt, fillColor,
 *   chips: [{ label, metric, unit, color }] }
 *
 * @module components/batteryCard
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';

export const MAX_CHIPS = 4;
export const DEFAULT_METRICS = Object.freeze({ soc: 'battery_soc', current: 'battery_current' });
const hexColor = c => (/^#[0-9a-f]{3,8}$/i.test(String(c || '').trim()) ? String(c).trim() : '');
const num = (v, fallback) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? fallback : n; };

/** The valid options of a card's config. */
export function batteryOptions(config = {}) {
  const metrics = { ...DEFAULT_METRICS };
  for (const k of Object.keys(DEFAULT_METRICS)) if (config.metrics && typeof config.metrics[k] === 'string' && config.metrics[k].trim()) metrics[k] = config.metrics[k].trim();
  const lowAt = Math.max(0, Math.min(100, num(config.lowAt, 20)));
  const warnAt = Math.max(lowAt, Math.min(100, num(config.warnAt, 50)));
  const currentMax = num(config.currentMax, 100) > 0 ? num(config.currentMax, 100) : 100;
  const chips = (Array.isArray(config.chips) ? config.chips : [])
    .map(c => ({ label: String((c && c.label) ?? '').trim().slice(0, 24), metric: String((c && c.metric) || '').trim(), unit: String((c && c.unit) || '').trim().slice(0, 12), color: hexColor(c && c.color) }))
    .filter(c => c.metric).slice(0, MAX_CHIPS);
  return {
    title: config.title === undefined ? 'Battery' : String(config.title || '').trim().slice(0, 60),
    metrics, showCurrent: config.showCurrent !== false, currentMax, lowAt, warnAt, fillColor: hexColor(config.fillColor), chips
  };
}

/** Which colour band a charge falls in. */
export function fillBand(soc, o) {
  if (!isNumericValue(soc)) return 'none';
  return soc <= o.lowAt ? 'low' : soc <= o.warnAt ? 'mid' : 'high';
}

/** Where the current marker sits on its track, as a fraction from the top: +max is 0, zero is 0.5, -max is 1. */
export function currentPosition(current, max) {
  if (!isNumericValue(current) || !(max > 0)) return null;
  return Math.max(0, Math.min(1, 0.5 - current / (2 * max)));
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

export function buildBatteryCard(block = {}) {
  const o = batteryOptions(block.config || {});
  const card = el('div', 'battery-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.batteryCfg = JSON.stringify(o);
  card.classList.toggle('bc-has-current', o.showCurrent);
  if (o.title) card.appendChild(el('div', 'bc-title', o.title));
  const body = el('div', 'bc-body');
  const scale = el('div', 'bc-scale');
  for (const t of [100, 75, 50, 25, 0]) scale.appendChild(el('span', 'bc-tick-label', t + '%'));
  const battery = el('div', 'bc-battery');
  battery.appendChild(el('div', 'bc-cap'));
  const shell = el('div', 'bc-shell');
  shell.appendChild(el('div', 'bc-fill'));
  for (const t of [25, 50, 75]) { const line = el('i', 'bc-tick'); line.style.bottom = t + '%'; shell.appendChild(line); }
  battery.appendChild(shell);
  body.append(scale, battery);
  if (o.showCurrent) {
    const cur = el('div', 'bc-current');
    cur.append(el('span', 'bc-cur-label bc-cur-top', '+' + o.currentMax));
    const track = el('div', 'bc-track');
    track.appendChild(el('i', 'bc-marker'));
    cur.appendChild(track);
    cur.append(el('span', 'bc-cur-label bc-cur-zero', '0'), el('span', 'bc-cur-label bc-cur-bottom', '−' + o.currentMax));
    body.appendChild(cur);
  }
  card.appendChild(body);
  const readout = el('div', 'bc-readout');
  readout.append(el('span', 'bc-soc', '—'), el('span', 'bc-amps'));
  card.appendChild(readout);
  if (o.chips.length) {
    const chips = el('div', 'bc-chips');
    o.chips.forEach((c, i) => {
      const chip = el('span', 'bc-chip'); chip.dataset.chip = String(i);
      const dot = el('i', 'bc-chip-dot'); if (c.color) dot.style.background = c.color;
      chip.append(dot, el('span', 'bc-chip-label', c.label), el('b', 'bc-chip-value', '—'));
      chips.appendChild(chip);
    });
    card.appendChild(chips);
  }
  return card;
}

export function updateBatteryCard(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.battery-card').forEach(card => {
    let o; try { o = JSON.parse(card.dataset.batteryCfg); } catch (e) { return; }
    const get = name => { const e = name ? metrics[name] : undefined; return e ? e.value : undefined; };
    const soc = get(o.metrics.soc), amps = get(o.metrics.current);
    const band = fillBand(soc, o);
    card.dataset.band = band;
    const fill = card.querySelector('.bc-fill');
    if (fill) {
      fill.style.height = isNumericValue(soc) ? Math.max(0, Math.min(100, soc)) + '%' : '0%';
      fill.style.background = o.fillColor || '';   // empty: the band colour from the stylesheet
    }
    card.querySelector('.bc-soc').textContent = isNumericValue(soc) ? Math.round(soc) + '%' : '—';
    // The unit of the current is the metric's own (A by default), on the amps and on the marker's labels.
    const curEntry = o.metrics.current ? metrics[o.metrics.current] : undefined;
    const unit = ((curEntry && curEntry.unit) || 'A').trim();
    const top = card.querySelector('.bc-cur-top'), zero = card.querySelector('.bc-cur-zero'), bottom = card.querySelector('.bc-cur-bottom');
    if (top) top.textContent = `+${o.currentMax} ${unit}`;
    if (zero) zero.textContent = `0 ${unit}`;
    if (bottom) bottom.textContent = `−${o.currentMax} ${unit}`;
    const ampsEl = card.querySelector('.bc-amps');
    if (ampsEl) {
      ampsEl.textContent = isNumericValue(amps) ? `${amps > 0 ? '+' : amps < 0 ? '−' : ''}${Math.abs(amps).toFixed(1)} ${unit}` : '';
      ampsEl.dataset.dir = isNumericValue(amps) ? (amps > 0.05 ? 'charge' : amps < -0.05 ? 'discharge' : 'idle') : '';
    }
    const marker = card.querySelector('.bc-marker');
    if (marker) {
      const pos = currentPosition(amps, o.currentMax);
      marker.hidden = pos === null;
      if (pos !== null) marker.style.top = (pos * 100) + '%';
    }
    o.chips.forEach((c, i) => {
      const target = card.querySelector(`.bc-chip[data-chip="${i}"] .bc-chip-value`);
      if (!target) return;
      const entry = metrics[c.metric];
      target.textContent = entry ? formatMetric(entry.value, c.unit || entry.unit || '').text : '—';
    });
  });
}
