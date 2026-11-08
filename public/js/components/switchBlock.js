import { escapeHtml } from '../utils.js';
import { emptyBlock } from './emptyState.js';
import { isStaleReading } from './readingAge.js';
import { iconHtml } from './buttonCard.js';
import { controlStyle, styleClasses, subLabelHtml } from './controlStyle.js';
import { isDeviceSetting, changeDeviceSetting, watchDeviceSetting } from './deviceSetting.js';

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
  const style = controlStyle(config, 'switch-block');
  container.className = ['switch-block', styleClasses(style, 'switch-block')].filter(Boolean).join(' ');
  container.dataset.blockId = id;
  // The state comes from the metric (HA and MQTT entities are an entity id or
  // topic, not the metric name); older cards only have `entity`.
  // An inverter or battery setting has no metric: it is read live (see deviceSetting.js).
  const device = isDeviceSetting(config);
  container.dataset.metric = device ? '' : (config.metric || config.entity || '');

  const label = escapeHtml(config.label || config.entity || 'Switch');
  const onIcon = config.onIcon || '';
  const offIcon = config.offIcon || '';
  container.dataset.onIcon = onIcon;
  container.dataset.offIcon = offIcon;

  // Apply per-state colors when configured (fall back to CSS defaults otherwise)
  if (config.onColor) container.style.setProperty('--switch-on-color', config.onColor);
  if (config.offColor) container.style.setProperty('--switch-off-color', config.offColor);

  // Icon and sub-label come from the card's style options; with none of them the card is as it was.
  const iconMarkup = config.icon ? `<span class="cs-icon" data-icon="${escapeHtml(config.icon)}">${iconHtml(config.icon)}</span>` : '';
  if (config.onColor) container.style.setProperty('--cs-on', config.onColor);
  if (config.offColor) container.style.setProperty('--cs-off', config.offColor);
  container.innerHTML = `
    ${iconMarkup}
    <div class="switch-label">${label}</div>
    ${subLabelHtml(style, 'cs-sub')}
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

  // In the tile and compact layouts the whole card is the switch.
  if (style.layout === 'tile' || style.layout === 'compact') {
    container.addEventListener('click', e => { if (!e.target.closest('.toggle-switch') && !checkbox.disabled) checkbox.click(); });
  }
  const paintOn = () => container.classList.toggle('is-on', checkbox.checked);
  checkbox.addEventListener('change', paintOn);
  paintOn();

  let activeController = null;
  let deviceValue = null;   // what the setting was when the card last read it
  let watcher = null;

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
      if (device) {
        // Sent only if the setting still is what the card showed; the device's read-back is the new state.
        const out = await changeDeviceSetting(config, this.checked, deviceValue);
        deviceValue = out.value === true || out.value === false ? out.value : this.checked;
        this.checked = deviceValue;
        setStateText(deviceValue);
        paintOn();
        return;
      }
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
      if (device) {
        // Refused or changed since: show what the setting is now.
        if (typeof e.current === 'boolean') { deviceValue = e.current; }
        watcher && watcher.refresh();
      }
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

  if (device) {
    watcher = watchDeviceSetting(container, config, result => {
      if (checkbox.disabled) return;   // a change is on its way
      if (result.error) {
        container.classList.add('is-unavailable');
        container.title = result.error;
        if (stateEl) stateEl.textContent = 'Unavailable';
        return;
      }
      container.classList.remove('is-unavailable');
      container.removeAttribute('title');
      deviceValue = !!result.value;
      checkbox.checked = deviceValue;
      setStateText(deviceValue);
      paintOn();
      // A setting this device can't change (for example a model it isn't for) is shown, not offered.
      checkbox.disabled = result.writable === false;
      if (result.writable === false && result.blockedReason) container.title = result.blockedReason;
    });
  }

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
    container.classList.toggle('is-on', isOn);
    if (stateEl) {
      const onIcon = container.dataset.onIcon || '';
      const offIcon = container.dataset.offIcon || '';
      stateEl.textContent = (isOn ? onIcon : offIcon) || '';
    }
  });
}
