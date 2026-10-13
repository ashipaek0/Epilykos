/**
 * Button card (Controls page): a big icon, the name and the state, like a Home
 * Assistant button card. Tapping runs the card's action: toggle, turn on,
 * turn off, press (HA button entities, one-shot actions) or nothing (status).
 *
 * config: { source, device, entity, metric, action, name, tapAction,
 *           icon, iconOff, onColor, offColor, showName, showState,
 *           onText, offText }
 * icon / iconOff: "mdi:fan" (see buttonIcons.js), an image URL or path
 * ("/uploads/ac.png", "https://…"), or an emoji. iconOff empty = same icon.
 */
import { escapeHtml } from '../utils.js';
import { emptyBlock } from './emptyState.js';
import { mdiSvg } from './buttonIcons.js';

const TIMEOUT_MS = 8000;
// After a change, keep showing it until a reading agrees (see switchBlock.js).
const PENDING_HOLD_MS = 45000;
// Home Assistant's default icon colours: active (amber) and inactive (blue).
export const DEFAULT_ON_COLOR = '#ffc107';
export const DEFAULT_OFF_COLOR = '#44739e';

const OFF_STATES = new Set(['off', 'false', '0', 'closed', 'idle', 'standby', 'none', 'not_home', '']);
const UNKNOWN_STATES = new Set(['unavailable', 'unknown']);

/** 'on' | 'off' | 'unknown' for a metric value. Anything not "off-like" (e.g. a climate mode) counts as on. */
export function stateOf(value) {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return value ? 'on' : 'off';
  const v = String(value).trim().toLowerCase();
  if (UNKNOWN_STATES.has(v)) return 'unknown';
  if (OFF_STATES.has(v)) return 'off';
  const n = Number(v);
  if (v !== '' && Number.isFinite(n)) return n ? 'on' : 'off';
  return 'on';
}

/** "On"/"Off" (or the card's own words), or the raw state for anything richer ("Cool"). */
export function stateLabel(value, config = {}) {
  const s = stateOf(value);
  if (s === 'unknown') return 'Unavailable';
  const raw = String(value).trim();
  const plain = /^(on|off|true|false|0|1|open|closed)$/i.test(raw) || typeof value !== 'string';
  if (s === 'on') return config.onText || (plain ? 'On' : raw.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));
  return config.offText || 'Off';
}

/** The HA domain of an entity id ("switch.fridge" → "switch"). */
function haDomain(entity) { return String(entity || '').split('.')[0]; }

/**
 * Body for POST /api/action, or null when the tap does nothing.
 * `isOn` is the state shown when tapped (toggle sends the opposite).
 */
export function actionRequest(config, isOn) {
  const tap = config.tapAction || 'toggle';
  if (tap === 'none' || !config.entity) return null;
  const want = tap === 'on' ? true : tap === 'off' ? false : tap === 'press' ? true : !isOn;
  const base = { source: config.source || 'ha', device: config.device || '', entity: config.entity };
  if (base.source === 'tuya') {
    // Tuya sets a DP to a value; a press is a momentary "on".
    return { ...base, action: 'set', params: { value: want } };
  }
  if (base.source === 'mqtt') {
    if (tap === 'press') return { ...base, action: 'press', params: { payload: 'PRESS' } };
    return { ...base, action: want ? 'turn_on' : 'turn_off' };
  }
  // Home Assistant
  const domain = haDomain(config.entity);
  if (tap === 'press' || domain === 'button' || domain === 'input_button' || domain === 'scene' || domain === 'script') {
    const service = domain === 'scene' || domain === 'script' ? 'turn_on' : 'press';
    return { ...base, action: `${domain}.${service}` };
  }
  return { ...base, action: `${domain}.${want ? 'turn_on' : 'turn_off'}` };
}

/** Markup for an icon setting: an MDI name, an image, or text (emoji). */
export function iconHtml(icon) {
  const v = String(icon || '').trim();
  if (!v) return mdiSvg('mdi:gesture-tap-button');
  const svg = mdiSvg(v);
  if (svg) return svg;
  if (/^(https?:)?\/\//i.test(v) || v.startsWith('/')) return `<img src="${escapeHtml(v)}" alt="" draggable="false">`;
  return `<span class="bc-emoji">${escapeHtml(v)}</span>`;
}

function paint(card, value) {
  const config = card._config || {};
  if (card.classList.contains('is-press')) {
    const stateEl = card.querySelector('.bc-state');
    if (stateEl && !card.classList.contains('bc-error')) stateEl.textContent = config.onText || 'Press';
    return;
  }
  const s = stateOf(value);
  card.classList.toggle('is-on', s === 'on');
  card.classList.toggle('is-off', s === 'off');
  card.classList.toggle('is-unknown', s === 'unknown');
  card.dataset.state = s;
  card.setAttribute('aria-pressed', String(s === 'on'));
  const iconEl = card.querySelector('.bc-icon');
  const want = s === 'on' || !config.iconOff ? config.icon : config.iconOff;
  if (iconEl && iconEl.dataset.icon !== String(want || '')) {
    iconEl.innerHTML = iconHtml(want);
    iconEl.dataset.icon = String(want || '');
  }
  const stateEl = card.querySelector('.bc-state');
  if (stateEl && !card.classList.contains('bc-error')) stateEl.textContent = stateLabel(value, config);
}

export function buildButtonCard(block = {}) {
  const config = block.config || {};
  if (!config.entity) return emptyBlock('Choose what this button controls in the layout editor.', block.id || '');
  const tap = config.tapAction || 'toggle';
  const interactive = tap !== 'none';
  const card = document.createElement(interactive ? 'button' : 'div');
  if (interactive) card.type = 'button';
  // A press button (HA button, scene, script) has no on/off: it shows ready,
  // in the "on" colour, rather than unknown.
  card.className = 'button-card ' + (tap === 'press' ? 'is-press' : 'is-unknown');
  card.dataset.blockId = block.id || '';
  card.dataset.metric = config.metric || config.entity;
  card._config = config;
  card.style.setProperty('--bc-on', config.onColor || DEFAULT_ON_COLOR);
  card.style.setProperty('--bc-off', config.offColor || DEFAULT_OFF_COLOR);
  const name = config.name || config.label || config.metric || config.entity;
  card.innerHTML =
    `<span class="bc-icon" data-icon="${escapeHtml(config.icon || '')}">${iconHtml(config.icon)}</span>` +
    (config.showName === false ? '' : `<span class="bc-name">${escapeHtml(name)}</span>`) +
    (config.showState === false ? '' : '<span class="bc-state">…</span>');
  if (interactive) card.setAttribute('aria-label', name);
  if (tap === 'press') paint(card, null);

  if (interactive) {
    card.addEventListener('click', async () => {
      if (card.disabled) return;
      const wasOn = card.dataset.state === 'on';
      const body = actionRequest(config, wasOn);
      if (!body) return;
      const before = card.dataset.value;
      card.disabled = true;
      // Optimistic: show the new state at once (a press just flashes).
      const momentary = tap === 'press';
      if (momentary) {
        card.classList.add('bc-pressed');
        setTimeout(() => card.classList.remove('bc-pressed'), 600);
      }
      if (!momentary) paint(card, body.params && body.params.value !== undefined ? body.params.value : /turn_on$/.test(body.action));
      card.classList.add('bc-busy');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch('/api/action', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
        if (!momentary) {
          card.dataset.pending = card.dataset.state;
          card.dataset.pendingUntil = String(Date.now() + PENDING_HOLD_MS);
        }
      } catch (e) {
        if (!momentary) paint(card, before);
        const stateEl = card.querySelector('.bc-state');
        card.classList.add('bc-error');
        if (stateEl) stateEl.textContent = e.name === 'AbortError' ? 'No answer' : e.message;
        setTimeout(() => { card.classList.remove('bc-error'); paint(card, card.dataset.value); }, 4000);
      } finally {
        clearTimeout(timer);
        card.classList.remove('bc-busy');
        card.disabled = false;
      }
    });
  }
  return card;
}

export function updateButtonCardsFromState(state) {
  document.querySelectorAll('.button-card').forEach(card => {
    const data = state.metrics && state.metrics[card.dataset.metric];
    if (!data) return;
    if (card.disabled) return; // a change is in flight
    // A reading older than the user's change: keep the change on screen.
    if (card.dataset.pending) {
      const held = Date.now() < Number(card.dataset.pendingUntil || 0);
      if (held && stateOf(data.value) !== card.dataset.pending) return;
      delete card.dataset.pending;
      delete card.dataset.pendingUntil;
    }
    card.dataset.value = data.value == null ? '' : String(data.value);
    paint(card, data.value);
  });
}
