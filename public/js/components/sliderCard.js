/**
 * Slider card (Controls page): drag to set a number on a device (a Home
 * Assistant number or input_number, a Tuya value, an MQTT topic).
 *
 * It is a native range input, so touch, the arrow keys, Home/End and screen
 * readers work as for any slider. Moving it only shows the value; the value is
 * sent once it is let go (see numericControl.js).
 *
 * @module components/sliderCard
 */
import { escapeHtml } from '../utils.js';
import { createNumericController, formatValue, fractionOf, rangeOf, updateNumericControls } from './numericControl.js';

/** An accent colour from the card's settings: #rgb to #rrggbbaa only. */
export function accentOf(config) {
  const c = String(config && config.color || '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : '';
}

export function buildSliderCard(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'ep-card numctl numctl-slider is-unknown';
  container.dataset.blockId = block.id || '';
  // The reading comes from the metric (an HA entity id or MQTT topic isn't one).
  container.dataset.metric = config.metric || config.entity || '';
  container.dataset.source = config.source || 'ha';
  const accent = accentOf(config);
  if (accent) container.style.setProperty('--nc-accent', accent);

  const label = escapeHtml(config.label || config.entity || 'Slider');
  if (!config.entity) {
    container.innerHTML = `<div class="numctl-label">${label}</div>`
      + '<div class="numctl-empty">Choose what this slider controls in the layout editor.</div>';
    return container;
  }

  const r = rangeOf(config);
  const unit = config.unit || '';
  container.innerHTML = `
    <div class="numctl-head"><span class="numctl-label">${label}</span><output class="numctl-value">—</output></div>
    <input type="range" class="numctl-range" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.min}" aria-label="${label}">
    <div class="numctl-scale"><span>${escapeHtml(formatValue(r.min, r, unit))}</span><span>${escapeHtml(formatValue(r.max, r, unit))}</span></div>
    <div class="numctl-status" role="status" aria-live="polite"></div>`;

  const input = container.querySelector('.numctl-range');
  const valueEl = container.querySelector('.numctl-value');
  const view = {
    show(v) {
      input.value = String(v);
      valueEl.textContent = formatValue(v, r, unit);
      container.style.setProperty('--nc-pct', `${(fractionOf(v, r) * 100).toFixed(1)}%`);
      input.setAttribute('aria-valuetext', formatValue(v, r, unit));
      container.classList.remove('is-unknown');
    },
    busy(isBusy) { input.disabled = isBusy; }
  };
  container.style.setProperty('--nc-pct', '0%');
  const control = createNumericController(container, config, view);

  input.addEventListener('input', () => control.preview(input.value));
  input.addEventListener('change', () => control.commitSoon(input.value));
  return container;
}

export function updateSliderCardsFromState(state) {
  updateNumericControls(state, '.numctl-slider');
}
