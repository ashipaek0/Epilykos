/**
 * What the slider and the rotary knob share: the range and its step, snapping
 * a value to it, how it reads, sending it, and keeping a change on screen
 * until the device's own reading agrees (as the switch and selector cards do).
 *
 * A control only sends when the user lets go (or stops pressing a key), never
 * while a handle is being dragged, so one gesture is one change, and one entry
 * in the Controls page's log.
 *
 * @module components/numericControl
 */
import { isStaleReading } from './readingAge.js';

const SEND_TIMEOUT_MS = 8000;
// After a change, keep showing it until a reading agrees (see switchBlock.js).
const PENDING_HOLD_MS = 45000;
// Keys and the end of a drag settle for this long before the value is sent.
export const COMMIT_DELAY_MS = 350;

/** Digits after the decimal point in a number as written (0.05 → 2). */
export function decimalsOf(n) {
  const s = String(n);
  if (/e-/i.test(s)) return Math.min(6, Number(s.split(/e-/i)[1]) || 0);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}

/** min, max, step and decimals from a card's config, always usable: min < max and step > 0. */
export function rangeOf(config = {}) {
  let min = Number(config.min), max = Number(config.max), step = Number(config.step);
  if (config.min === '' || config.min == null || !Number.isFinite(min)) min = 0;
  if (config.max === '' || config.max == null || !Number.isFinite(max) || max <= min) max = min + 100;
  if (config.step === '' || config.step == null || !Number.isFinite(step) || step <= 0) step = 1;
  if (step > max - min) step = max - min;
  const wanted = Number(config.decimals);
  const decimals = config.decimals !== '' && config.decimals != null && Number.isInteger(wanted) && wanted >= 0
    ? Math.min(wanted, 6) : Math.max(decimalsOf(step), decimalsOf(min));
  return { min, max, step, decimals };
}

/** The value on the step grid nearest to `value`, kept inside the range; null when it is not a number. */
export function snap(value, r) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n)) return null;
  const clamped = Math.min(r.max, Math.max(r.min, n));
  const snapped = r.min + Math.round((clamped - r.min) / r.step) * r.step;
  const digits = Math.max(r.decimals, decimalsOf(r.step), decimalsOf(r.min));
  return Math.min(r.max, Number(snapped.toFixed(digits)));
}

/** How far along the range a value is, 0 to 1. */
export function fractionOf(value, r) {
  return Math.min(1, Math.max(0, (value - r.min) / (r.max - r.min)));
}

/** The value text: "42 %", "21.5 °C", "1200 W". */
export function formatValue(value, r, unit = '') {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const text = Number(value).toFixed(r.decimals);
  if (!unit) return text;
  return /^(%|°)/.test(unit) ? text + unit : `${text} ${unit}`;
}

/** Send one value for a card's control, through the same route as the other control cards. */
export async function sendValue(config, value, doFetch = (typeof fetch === 'function' ? fetch : null)) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await doFetch('/api/action', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        source: config.source || 'ha',
        device: config.device,
        action: config.action,
        entity: config.entity,
        params: { value }
      })
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* a reply with no body */ }
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The behaviour of one control card. `view` draws it:
 *   view.show(value)       show this value (a drag, or a reading)
 *   view.busy(isBusy)      lock the control while a change is on its way
 * The card's element gets `._numeric` so the updater can reach it.
 */
export function createNumericController(container, config, view, { doFetch, now = () => Date.now() } = {}) {
  const r = rangeOf(config);
  const statusEl = container.querySelector('.numctl-status');
  let settled = null;         // the value the device is known to have, or was last sent
  let timer = null, sending = false, messageTimer = null;

  const say = text => {
    if (!statusEl) return;
    statusEl.textContent = text;
    clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { statusEl.textContent = ''; }, 4000);
  };

  async function commit(value) {
    clearTimeout(timer); timer = null;
    delete container.dataset.dragging;
    if (value == null || value === settled) return;
    sending = true; container.dataset.busy = '1'; container.classList.add('is-busy'); view.busy(true); say('');
    try {
      await sendValue(config, value, doFetch);
      settled = value;
      container.dataset.pending = String(value);
      container.dataset.pendingUntil = String(now() + PENDING_HOLD_MS);
    } catch (e) {
      if (settled != null) view.show(settled);
      say(`Error: ${e.message}`);
      container.classList.add('is-error'); setTimeout(() => container.classList.remove('is-error'), 800);
    } finally {
      sending = false; delete container.dataset.busy; container.classList.remove('is-busy'); view.busy(false);
    }
  }

  const api = {
    range: r,
    /** The control is being moved: show the value, send nothing yet. */
    preview(raw) {
      const v = snap(raw, r);
      if (v == null) return null;
      container.dataset.dragging = '1';
      view.show(v);
      return v;
    },
    /** The control was let go: send the value now. */
    commitNow(raw) { const v = snap(raw, r); return commit(v); },
    /** The control moved by key or in small steps: send once it settles. */
    commitSoon(raw) {
      const v = snap(raw, r);
      if (v == null) return null;
      container.dataset.dragging = '1';
      view.show(v);
      clearTimeout(timer);
      timer = setTimeout(() => commit(v), COMMIT_DELAY_MS);
      return v;
    },
    /** A reading from the device. Ignored while the user is moving the control or a change is in flight. */
    reading(raw, source, data) {
      const stale = isStaleReading(source, data);
      container.classList.toggle('is-unavailable', stale);
      container.title = stale ? 'The device is not answering' : '';
      const v = snap(raw, r);
      if (v == null || stale) return;
      if (container.dataset.pending) {
        const held = now() < Number(container.dataset.pendingUntil || 0);
        if (held && Number(container.dataset.pending) !== v) return;   // an older reading than the change
        delete container.dataset.pending; delete container.dataset.pendingUntil;
      }
      if (sending || container.dataset.dragging) return;
      settled = v;
      view.show(v);
    },
    get settled() { return settled; }
  };
  container._numeric = api;
  return api;
}

/** Give every control card of a kind its device's latest reading. */
export function updateNumericControls(state, selector) {
  for (const container of document.querySelectorAll(selector)) {
    const metric = container.dataset.metric;
    const data = metric && state && state.metrics ? state.metrics[metric] : null;
    if (!container._numeric || !data || data.value == null) continue;
    container._numeric.reading(data.value, container.dataset.source, data);
  }
}
