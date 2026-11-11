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
import { isDeviceSetting, changeDeviceSetting, watchDeviceSetting } from './deviceSetting.js';

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

/**
 * Send one value for a card's control, through the same route as the other control cards.
 * An inverter or battery setting goes through /api/controls/change instead, with `expected`,
 * the value the card last showed; that resolves the device's read-back value.
 */
export async function sendValue(config, value, doFetch = (typeof fetch === 'function' ? fetch : null), expected) {
  if (isDeviceSetting(config)) {
    try { return (await changeDeviceSetting(config, value, expected, doFetch)).value; }
    catch (e) { const err = new Error((e && e.message) || 'failed'); if (e && e.current !== undefined) err.current = e.current; throw err; }
  }
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
  let timer = null, sending = false, messageTimer = null, watcher = null;

  // Why the control can't be used (it can't be read, or can't be changed) stays on the card
  // until that changes; a message about a change fades after a few seconds back to it.
  let note = '';
  const show = text => { if (statusEl) statusEl.textContent = text; };
  const say = text => {
    clearTimeout(messageTimer);
    show(text || note);
    if (text) messageTimer = setTimeout(() => show(note), 4000);
  };
  const setNote = text => { note = text || ''; if (!messageTimer) show(note); };

  async function commit(value) {
    clearTimeout(timer); timer = null;
    delete container.dataset.dragging;
    if (value == null || value === settled) return;
    sending = true; container.dataset.busy = '1'; container.classList.add('is-busy'); view.busy(true); say('');
    try {
      const back = await sendValue(config, value, doFetch, settled);
      // A device setting reports the value it read back: that is what it now is.
      settled = isDeviceSetting(config) && Number.isFinite(Number(back)) ? Number(back) : value;
      if (settled !== value) view.show(settled);
      container.dataset.pending = String(settled);
      container.dataset.pendingUntil = String(now() + PENDING_HOLD_MS);
    } catch (e) {
      if (e && e.current !== undefined && Number.isFinite(Number(e.current))) settled = Number(e.current);
      if (settled != null) view.show(settled);
      say(`Error: ${e.message}`);
      if (isDeviceSetting(config) && watcher) watcher.refresh();   // show what it is now
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
      // What the device has, as it is. The card's own step or range may not fit it (45 A on a
      // step of 10): showing or remembering the nearest step would send that as "the value
      // you saw", and the device refuses it as changed since. The control itself still moves in steps.
      const exact = Number(raw);
      settled = exact;
      view.show(exact);
    },
    get settled() { return settled; }
  };
  container._numeric = api;
  // An inverter or battery setting has no polled metric: read it live now and every minute.
  if (isDeviceSetting(config)) {
    watcher = watchDeviceSetting(container, config, result => {
      if (sending) return;   // a change is on its way
      if (result.error) {
        container.classList.add('is-unavailable'); container.title = result.error;
        setNote(`Can't read this setting: ${result.error}`);
        return;
      }
      container.classList.remove('is-unavailable');
      container.removeAttribute('title');
      api.reading(result.value, 'device', {});
      const locked = result.writable === false;
      view.busy(locked);
      if (locked && result.blockedReason) container.title = result.blockedReason;
      setNote(locked ? `Can't be changed: ${result.blockedReason || 'the device does not allow it now'}` : '');
    }, { doFetch });
  }
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
