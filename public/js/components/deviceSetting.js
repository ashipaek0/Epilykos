/**
 * Control cards for an inverter or battery setting (config.source === 'device').
 *
 * Those settings are not read from a polled metric and are not sent through
 * /api/action. A card reads its setting live from /api/controls/read (when it
 * is drawn, then every minute while the page is open, and after each change)
 * and changes it through /api/controls/change, which keeps every safety rule:
 * the current value is read first and must match what the card last showed
 * (`expected`), the value is read back, the attempt is logged, and
 * "Device changes" and the password unlock apply.
 *
 * @module components/deviceSetting
 */
const TIMEOUT_MS = 20000;   // an inverter read goes through a dongle or Bluetooth: slower than a switch
export const REFRESH_MS = 60000;

export const isDeviceSetting = config => !!config && config.source === 'device';

async function post(path, body, doFetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(path, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body)
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* a reply with no body */ }
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, data: { error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'failed' } };
  } finally { clearTimeout(timer); }
}

/** The setting now: { value, writable, blockedReason } or { error }. */
export async function readDeviceSetting(config, doFetch = fetch) {
  const { ok, data } = await post('/api/controls/read', { device: config.device, setting: config.entity }, doFetch);
  if (!ok || data.error) return { error: data.error || 'could not read it' };
  return { value: data.value, writable: data.writable !== false, blockedReason: data.blockedReason || '' };
}

/**
 * Change it. `expected` is the value the card last showed. Resolves { value }
 * (the device's read-back); rejects with the reason, and `err.current` when the
 * setting had changed since (so the card can show what it is now).
 */
export async function changeDeviceSetting(config, value, expected, doFetch = fetch) {
  const { ok, data } = await post('/api/controls/change', { device: config.device, setting: config.entity, value, expected }, doFetch);
  if (ok && data.success !== false && !data.error) return { value: data.value !== undefined ? data.value : value };
  const err = new Error(data.error || 'the change was refused');
  if (data.current !== undefined) err.current = data.current;
  throw err;
}

/**
 * Keep a card in step with its setting: read now, then every REFRESH_MS while
 * the card is on the page and the tab is visible. `apply(result)` gets each
 * read ({ value, writable, blockedReason } or { error }). Returns { refresh() },
 * which reads again at once (after a change, or when the setting had changed).
 */
export function watchDeviceSetting(container, config, apply, { doFetch, refreshMs = REFRESH_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let busy = false, timer = null;
  async function refresh() {
    if (busy) return;
    busy = true;
    try { apply(await readDeviceSetting(config, doFetch)); } finally { busy = false; }
  }
  timer = setTimer(() => {
    if (!container.isConnected) { clearTimer(timer); return; }
    if (typeof document !== 'undefined' && document.hidden) return;
    refresh();
  }, refreshMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  refresh();
  return { refresh };
}
