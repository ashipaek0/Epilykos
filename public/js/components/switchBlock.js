import { escapeHtml } from '../utils.js';

export function buildSwitchBlock(block = {}) {
  const config = block.config || {};
  const id = block.id || '';
  const container = document.createElement('div');
  container.className = 'switch-block';
  container.dataset.blockId = id;
  container.dataset.metric = config.entity || '';

  const label = escapeHtml(config.label || config.entity || 'Switch');
  container.innerHTML = `
    <div class="switch-label">${label}</div>
    <div class="switch-control">
      <span class="switch-state">--</span>
      <label class="toggle-switch action-toggle">
        <input type="checkbox" data-action data-source="${escapeHtml(config.source || 'ha')}"
               data-device="${escapeHtml(config.device || '')}"
               data-entity="${escapeHtml(config.entity || '')}"
               data-action="${escapeHtml(config.action || 'switch.toggle')}">
        <span class="slider"></span>
      </label>
    </div>
  `;

  // Click handler with optimistic UI + revert
  const checkbox = container.querySelector('input[type="checkbox"]');
  checkbox.addEventListener('change', async function () {
    const wasChecked = !this.checked; // pre-toggle state (for revert)
    this.disabled = true;

    try {
      const res = await fetch('/api/action', {
        method: 'POST',
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
    } catch (e) {
      // Revert on error
      this.checked = wasChecked;
      const stateEl = container.querySelector('.switch-state');
      if (stateEl) stateEl.textContent = `Error: ${e.message}`;
      setTimeout(() => {
        if (stateEl) stateEl.textContent = wasChecked ? 'ON' : 'OFF';
      }, 3000);
    } finally {
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
    if (stateEl) stateEl.textContent = isOn ? 'ON' : 'OFF';
  });
}
