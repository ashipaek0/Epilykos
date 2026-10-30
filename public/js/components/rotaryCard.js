/**
 * Rotary card (Controls page): a knob that turns through 270° to set a number
 * on a device (a Home Assistant number or input_number, a Tuya value, an MQTT
 * topic).
 *
 * Dragging is relative: it turns from wherever you grab it, so a tap on the
 * knob changes nothing. The arrow keys, Page Up/Down, Home and End work too
 * (the knob is a slider to a screen reader). Turning only shows the value; it
 * is sent when you let go or stop pressing keys (see numericControl.js).
 *
 * @module components/rotaryCard
 */
import { escapeHtml } from '../utils.js';
import { createNumericController, formatValue, fractionOf, rangeOf, updateNumericControls } from './numericControl.js';
import { accentOf } from './sliderCard.js';

const CENTER = 60, TRACK_R = 46;
/** The knob turns from 135° (bottom left) clockwise through 270° to 45° (bottom right), in SVG degrees. */
export const START_DEG = 135, SWEEP_DEG = 270;

const point = (r, deg) => {
  const a = deg * Math.PI / 180;
  return [CENTER + r * Math.cos(a), CENTER + r * Math.sin(a)];
};

/** The arc along the track from the start of the sweep to a fraction (0 to 1) of it, as an SVG path. */
export function arcPath(fraction, r = TRACK_R) {
  const f = Math.min(1, Math.max(0, fraction));
  if (f <= 0) return '';
  const [x0, y0] = point(r, START_DEG), [x1, y1] = point(r, START_DEG + SWEEP_DEG * f);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${SWEEP_DEG * f > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** The shortest signed turn from one angle to another, in degrees (-180 to 180). */
export function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

/** The angle of a pointer relative to the knob's centre, in degrees (0 = right, clockwise). */
export const pointerAngle = (dx, dy) => Math.atan2(dy, dx) * 180 / Math.PI;

export function buildRotaryCard(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'ep-card numctl numctl-rotary is-unknown';
  container.dataset.blockId = block.id || '';
  container.dataset.metric = config.metric || config.entity || '';
  container.dataset.source = config.source || 'ha';
  const accent = accentOf(config);
  if (accent) container.style.setProperty('--nc-accent', accent);

  const label = escapeHtml(config.label || config.entity || 'Knob');
  if (!config.entity) {
    container.innerHTML = `<div class="numctl-label">${label}</div>`
      + '<div class="numctl-empty">Choose what this knob controls in the layout editor.</div>';
    return container;
  }

  const r = rangeOf(config);
  const unit = config.unit || '';
  container.innerHTML = `
    <div class="numctl-label">${label}</div>
    <div class="numctl-knob" role="slider" tabindex="0" aria-label="${label}" aria-valuemin="${r.min}" aria-valuemax="${r.max}">
      <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <path class="knob-track" d="${arcPath(1)}"/>
        <path class="knob-fill" d=""/>
        <circle class="knob-cap" cx="${CENTER}" cy="${CENTER}" r="32"/>
        <line class="knob-mark" x1="${CENTER}" y1="${CENTER - 35}" x2="${CENTER}" y2="${CENTER - 41}"/>
      </svg>
      <output class="numctl-value">—</output>
    </div>
    <div class="numctl-scale"><span>${escapeHtml(formatValue(r.min, r, unit))}</span><span>${escapeHtml(formatValue(r.max, r, unit))}</span></div>
    <div class="numctl-status" role="status" aria-live="polite"></div>`;

  const knob = container.querySelector('.numctl-knob');
  const fill = container.querySelector('.knob-fill');
  const mark = container.querySelector('.knob-mark');
  const valueEl = container.querySelector('.numctl-value');
  let current = null;
  const view = {
    show(v) {
      current = v;
      const f = fractionOf(v, r);
      fill.setAttribute('d', arcPath(f));
      mark.setAttribute('transform', `rotate(${(START_DEG + 90 + SWEEP_DEG * f - 360).toFixed(1)} ${CENTER} ${CENTER})`);
      valueEl.textContent = formatValue(v, r, unit);
      knob.setAttribute('aria-valuenow', String(v));
      knob.setAttribute('aria-valuetext', formatValue(v, r, unit));
      container.classList.remove('is-unknown');
    },
    busy(isBusy) { knob.setAttribute('aria-disabled', String(isBusy)); knob.style.pointerEvents = isBusy ? 'none' : ''; }
  };
  const control = createNumericController(container, config, view);

  // Turning with a pointer: relative to where it was grabbed.
  let drag = null;
  const angleAt = e => {
    const box = knob.getBoundingClientRect();
    return pointerAngle(e.clientX - (box.left + box.width / 2), e.clientY - (box.top + box.height / 2));
  };
  knob.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { angle: angleAt(e), fraction: current == null ? 0 : fractionOf(current, r), value: current, moved: false };
    try { knob.setPointerCapture(e.pointerId); } catch (_) { /* not every environment can capture */ }
    knob.focus({ preventScroll: true });
    e.preventDefault();
  });
  knob.addEventListener('pointermove', e => {
    if (!drag) return;
    const now = angleAt(e);
    drag.fraction = Math.min(1, Math.max(0, drag.fraction + angleDelta(drag.angle, now) / SWEEP_DEG));
    drag.angle = now;
    const v = control.preview(r.min + drag.fraction * (r.max - r.min));
    if (v != null) { drag.value = v; drag.moved = true; }
  });
  const release = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) control.commitNow(d.value);
  };
  knob.addEventListener('pointerup', release);
  knob.addEventListener('pointercancel', release);

  // Keys.
  knob.addEventListener('keydown', e => {
    if (current == null && !/^(Arrow|Page|Home|End)/.test(e.key)) return;
    const base = current == null ? r.min : current;
    let next = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = base + r.step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = base - r.step;
    else if (e.key === 'PageUp') next = base + r.step * 10;
    else if (e.key === 'PageDown') next = base - r.step * 10;
    else if (e.key === 'Home') next = r.min;
    else if (e.key === 'End') next = r.max;
    if (next == null) return;
    e.preventDefault();
    control.commitSoon(next);
  });
  return container;
}

export function updateRotaryCardsFromState(state) {
  updateNumericControls(state, '.numctl-rotary');
}
