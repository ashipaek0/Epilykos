import { escapeHtml } from '../utils.js';
import { emptyBlock } from './emptyState.js';
import { isStaleReading } from './readingAge.js';

const SWITCH_TIMEOUT_MS = 8000;
// After a change, keep showing it until a reading agrees (the device may not
// be polled again for 30 s, and the page refreshes sooner than that).
const PENDING_HOLD_MS = 45000;

export function buildSwitchBlock(block = {}) {
  const config = block.config || {};
  const id = block.id || '';
  // No entity: nothing to switch, so no toggle that would send an empty action.
  if (!config.entity) return emptyBlock('Choose the switch for this block in the layout editor.', id);
  const container = document.createElement('div');
  container.className = 'switch-block';
  container.dataset.blockId = id;
  // The state comes from the metric (HA and MQTT entities are an entity id or
  // topic, not the metric name); older cards only have `entity`.
  container.dataset.metric = config.metric || config.entity || '';

  const label = escapeHtml(config.label || config.entity || 'Switch');
  const onIcon = config.onIcon || '';
  const offIcon = config.offIcon || '';
  container.dataset.onIcon = onIcon;
  container.dataset.offIcon = offIcon;

  // Apply per-state colors when configured (fall back to CSS defaults otherwise)
  if (config.onColor) container.style.setProperty('--switch-on-color', config.onColor);
  if (config.offColor) container.style.setProperty('--switch-off-color', config.offColor);

  container.innerHTML = `
    <div class="switch-label">${label}</div>
    <div class="switch-control">
      <span class="switch-state"></span>
      <label class="toggle-switch action-toggle">
        <input type="checkbox" role="switch" aria-label="${label}" data-source="${escapeHtml(config.source || 'ha')}"
               data-device="${escapeHtml(config.device || '')}"
               data-entity="${escapeHtml(config.entity || '')}"
               data-action="${escapeHtml(config.action || 'switch.toggle')}">
        <span class="slider"></span>
      </label>
    </div>
  `;

  // Click handler with optimistic UI + 8s timeout revert
  const checkbox = container.querySelector('input[type="checkbox"]');
  const stateEl = container.querySelector('.switch-state');

  // The switch shows the state, like the Settings switches; text only for
  // configured icons (and errors).
  const stateText = (isOn) => (isOn ? onIcon : offIcon) || '';
  const setStateText = (isOn) => { if (stateEl) stateEl.textContent = stateText(isOn); };
  setStateText(false);

  let activeController = null;

  checkbox.addEventListener('change', async function () {
    const wasChecked = !this.checked; // pre-toggle state (for revert)
    this.disabled = true;

    // Abort any previous in-flight request (rapid re-toggle)
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;

    // Hard timeout: if the API does not answer in 8s, treat it as a failure
    const timeoutId = setTimeout(() => controller.abort(), SWITCH_TIMEOUT_MS);

    const fail = (msg) => {
      this.checked = wasChecked;
      setStateText(wasChecked);
      if (stateEl) stateEl.textContent = `Error: ${msg}`;
      container.classList.add('switch-error');
      setTimeout(() => {
        container.classList.remove('switch-error');
        setStateText(this.checked);
      }, 3000);
    };

    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(Object.assign({
          source: this.dataset.source,
          device: this.dataset.device,
          action: this.dataset.action,
          entity: this.dataset.entity
        // Tuya sets a DP to a value (without one it can only switch on).
        // Home Assistant would pass params on as service data, so only Tuya gets it.
        }, this.dataset.source === 'tuya' ? { params: { value: this.checked } } : {}))
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStateText(this.checked);
      container.dataset.pending = this.checked ? 'on' : 'off';
      container.dataset.pendingUntil = String(Date.now() + PENDING_HOLD_MS);
    } catch (e) {
      if (e.name === 'AbortError') {
        fail('timeout');
      } else {
        fail(e.message);
      }
    } finally {
      clearTimeout(timeoutId);
      if (activeController === controller) activeController = null;
      this.disabled = false;
    }
  });

  return container;
}

export function updateSwitchBlockFromState(state) {
  document.querySelectorAll('.switch-block').forEach(container => {
    const metric = container.dataset.metric;
    if (!metric) return;
    const data = state.metrics?.[metric];
    if (!data || data.value == null) return;

    const checkbox = container.querySelector('input[type="checkbox"]');
    const stateEl = container.querySelector('.switch-state');
    // Not answering: show it as off-and-unknown rather than its last reading.
    const stale = isStaleReading(checkbox && checkbox.dataset.source, data);
    container.classList.toggle('is-unavailable', stale);
    if (stale) {
      if (checkbox && !checkbox.disabled && !container.dataset.pending) checkbox.checked = false;
      if (stateEl) stateEl.textContent = 'Unavailable';
      container.title = 'The device is not answering';
      return;
    }
    container.removeAttribute('title');
    const v = typeof data.value === 'string' ? data.value.toLowerCase() : data.value;
    const isOn = v === 'on' || v === true || v === 1 || v === 'true' || v === '1';
    // A reading older than the user's change: keep the change on screen.
    if (container.dataset.pending) {
      const held = Date.now() < Number(container.dataset.pendingUntil || 0);
      if (held && (container.dataset.pending === 'on') !== isOn) return;
      delete container.dataset.pending;
      delete container.dataset.pendingUntil;
    }
    if (checkbox && checkbox.disabled) return; // a change is in flight

    if (checkbox) checkbox.checked = isOn;
    if (stateEl) {
      const onIcon = container.dataset.onIcon || '';
      const offIcon = container.dataset.offIcon || '';
      stateEl.textContent = (isOn ? onIcon : offIcon) || '';
    }
  });
}
