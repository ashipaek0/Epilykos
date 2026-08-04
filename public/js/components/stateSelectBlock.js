import { escapeHtml } from '../utils.js';

export function buildStateSelectBlock(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'state-select-block';
  container.dataset.blockId = block.id || '';
  container.dataset.metric = config.entity || '';

  const label = escapeHtml(config.label || config.entity || 'Mode');
  const states = config.states || [];
  const stateLabels = config.stateLabels || states;

  const buttons = states.map((state, i) => {
    const lbl = escapeHtml(stateLabels[i] || state);
    return `<button class="state-btn" data-value="${escapeHtml(state)}">${lbl}</button>`;
  }).join('');

  container.innerHTML = `
    <div class="state-select-label">${label}</div>
    <div class="state-select-buttons">${buttons}</div>
    <div class="state-select-status"></div>
  `;

  // Click handlers
  container.querySelectorAll('.state-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const value = this.dataset.value;
      const previousActive = container.querySelector('.state-btn.active');

      // Optimistic UI
      container.querySelectorAll('.state-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      this.disabled = true;

      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({
            source: config.source || 'ha',
            device: config.device,
            action: config.action,
            entity: config.entity,
            params: { value: value }
          })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      } catch (e) {
        // Revert
        container.querySelectorAll('.state-btn').forEach(b => b.classList.remove('active'));
        if (previousActive) previousActive.classList.add('active');
        const statusEl = container.querySelector('.state-select-status');
        if (statusEl) {
          statusEl.textContent = `Error: ${e.message}`;
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
      } finally {
        this.disabled = false;
      }
    });
  });

  return container;
}

export function updateStateSelectBlockFromState(state) {
  document.querySelectorAll('.state-select-block').forEach(container => {
    const metric = container.dataset.metric;
    if (!metric) return;
    const data = state.metrics?.[metric];
    if (!data || data.value == null) return;

    const currentValue = String(data.value).toLowerCase();
    container.querySelectorAll('.state-btn').forEach(btn => {
      const btnValue = btn.dataset.value.toLowerCase();
      if (btnValue === currentValue) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  });
}
