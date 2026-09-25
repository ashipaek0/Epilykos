import { escapeHtml } from '../utils.js';

const SWITCH_TIMEOUT_MS = 8000;

export function buildSwitchBlock(block = {}) {
  const config = block.config || {};
  const id = block.id || '';
  const container = document.createElement('div');
  container.className = 'switch-block';
  container.dataset.blockId = id;
  container.dataset.metric = config.entity || '';

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
      <span class="switch-state">--</span>
      <label class="toggle-switch action-toggle">
        <input type="checkbox" data-source="${escapeHtml(config.source || 'ha')}"
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

  const stateText = (isOn) => (isOn ? (onIcon ? `${onIcon} ON` : 'ON') : (offIcon ? `${offIcon} OFF` : 'OFF'));
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
        body: JSON.stringify({
          source: this.dataset.source,
          device: this.dataset.device,
          action: this.dataset.action,
          entity: this.dataset.entity
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStateText(this.checked);
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
    const isOn = data.value === 'on' || data.value === true || data.value === 1 || data.value === 'true';

    if (checkbox) checkbox.checked = isOn;
    if (stateEl) {
      const onIcon = container.dataset.onIcon || '';
      const offIcon = container.dataset.offIcon || '';
      stateEl.textContent = isOn ? (onIcon ? `${onIcon} ON` : 'ON') : (offIcon ? `${offIcon} OFF` : 'OFF');
    }
  });
}
