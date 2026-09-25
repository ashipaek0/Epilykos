import { escapeHtml } from '../utils.js';

const STATE_TIMEOUT_MS = 8000;

/** Normalize `config.states` to [{value,label,color,icon}].
 *  Accepts the spec shape [{value,label}] as well as the legacy flat form
 *  (array of strings, optionally paired with config.stateLabels). */
function normalizeStates(config) {
  const raw = Array.isArray(config.states) ? config.states : [];
  const labels = Array.isArray(config.stateLabels) ? config.stateLabels : null;
  return raw.map((s, i) => {
    if (s && typeof s === 'object') {
      return {
        value: s.value != null ? String(s.value) : '',
        label: s.label != null ? String(s.label) : (labels && labels[i] != null ? String(labels[i]) : ''),
        color: s.color || '',
        icon: s.icon || ''
      };
    }
    // Legacy flat string form
    return {
      value: String(s ?? ''),
      label: labels && labels[i] != null ? String(labels[i]) : String(s ?? ''),
      color: '',
      icon: ''
    };
  }).filter(s => s.value !== '');
}

function stateText(s) {
  return s.icon ? `${s.icon} ${s.label}` : s.label;
}

export function buildStateSelectBlock(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'state-select-block';
  container.dataset.blockId = block.id || '';
  container.dataset.metric = config.entity || '';

  const label = escapeHtml(config.label || config.entity || 'Mode');
  const states = normalizeStates(config);
  const displayStyle = config.displayStyle === 'dropdown' ? 'dropdown' : 'buttons';
  const statusHtml = '<div class="state-select-status"></div>';

  // Zero states → placeholder instead of an empty div
  if (!states.length) {
    container.innerHTML = `
      <div class="state-select-label">${label}</div>
      <div class="state-select-empty">No states configured</div>
      ${statusHtml}
    `;
    return container;
  }

  let selectEl = null;
  let statusEl = null;

  if (displayStyle === 'dropdown') {
    const opts = states.map(s => {
      return `<option value="${escapeHtml(s.value)}"${s.color ? ` data-color="${escapeHtml(s.color)}"` : ''}>${escapeHtml(stateText(s))}</option>`;
    }).join('');
    container.innerHTML = `
      <div class="state-select-label">${label}</div>
      <select class="state-select-dropdown" aria-label="${label}">
        <option value="">-- select --</option>
        ${opts}
      </select>
      ${statusHtml}
    `;
    selectEl = container.querySelector('.state-select-dropdown');
  } else {
    const buttons = states.map(s => {
      return `<button type="button" class="state-btn" data-value="${escapeHtml(s.value)}"${s.color ? ` style="--state-color:${escapeHtml(s.color)}"` : ''}>${escapeHtml(stateText(s))}</button>`;
    }).join('');
    container.innerHTML = `
      <div class="state-select-label">${label}</div>
      <div class="state-select-buttons">${buttons}</div>
      ${statusHtml}
    `;
  }

  statusEl = container.querySelector('.state-select-status');

  const controls = container.querySelectorAll('.state-btn, .state-select-dropdown');

  const selectedOption = () => {
    let sel = null;
    if (!selectEl) return sel;
    selectEl.querySelectorAll('option').forEach(o => { if (o.selected) sel = o; });
    return sel;
  };
  const applySelectColor = () => {
    if (!selectEl) return;
    const sel = selectedOption();
    const color = sel ? (sel.dataset.color || '') : '';
    selectEl.style.borderColor = color || '';
    selectEl.style.color = color || '';
  };

  /** Shared POST path — disables the WHOLE selector during the API call. */
  async function send(value, btnEl, previousValue) {
    const previousActive = container.querySelector('.state-btn.active');
    controls.forEach(c => { c.disabled = true; });

    // Optimistic UI
    if (btnEl) {
      container.querySelectorAll('.state-btn').forEach(b => b.classList.remove('active'));
      btnEl.classList.add('active');
    }
    if (selectEl) applySelectColor();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STATE_TIMEOUT_MS);

    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        signal: controller.signal,
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
      if (selectEl && previousValue !== undefined && previousValue !== null) {
        let restored = false;
        selectEl.querySelectorAll('option').forEach(o => {
          if (o.value === previousValue) { o.selected = true; restored = true; }
        });
        if (!restored) {
          const first = selectEl.querySelector('option');
          if (first) first.selected = true;
        }
        applySelectColor();
      }
      if (statusEl) {
        statusEl.textContent = `Error: ${e.name === 'AbortError' ? 'timeout' : e.message}`;
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      }
    } finally {
      clearTimeout(timeoutId);
      controls.forEach(c => { c.disabled = false; });
    }
  }

  if (selectEl) {
    selectEl.addEventListener('change', function () {
      if (this.disabled) return;
      const value = this.value;
      if (!value) return;
      const previousValue = this.dataset.previousValue ?? '';
      this.dataset.previousValue = value;
      send(value, null, previousValue);
    });
  } else {
    container.querySelectorAll('.state-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        if (this.disabled) return;
        send(this.dataset.value, this, undefined);
      });
    });
  }

  return container;
}

export function updateStateSelectBlockFromState(state) {
  document.querySelectorAll('.state-select-block').forEach(container => {
    const metric = container.dataset.metric;
    if (!metric) return;
    const data = state.metrics?.[metric];
    if (!data || data.value == null) return;

    const currentValue = String(data.value).toLowerCase();
    const selectEl = container.querySelector('.state-select-dropdown');

    if (selectEl) {
      let matched = false;
      selectEl.querySelectorAll('option').forEach(opt => {
        const match = String(opt.value).toLowerCase() === currentValue ||
                      String(opt.textContent).trim().toLowerCase() === currentValue;
        if (match) {
          opt.selected = true;
          matched = true;
        }
      });
      if (!matched) {
        const first = selectEl.querySelector('option');
        if (first) first.selected = true;
      }
      const sel = selectEl.querySelectorAll('option');
      let color = '';
      for (let i = 0; i < sel.length; i++) {
        if (sel[i].selected) { color = sel[i].dataset.color || ''; break; }
      }
      selectEl.style.borderColor = color || '';
      selectEl.style.color = color || '';
    } else {
      container.querySelectorAll('.state-btn').forEach(btn => {
        const btnValue = btn.dataset.value.toLowerCase();
        if (btnValue === currentValue) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }
  });
}
