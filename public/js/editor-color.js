/**
 * In-page colour picker for the layout editor. The browser's own picker for
 * <input type="color"> is a popup the page can't place or size, so in the
 * narrow settings panel it ran past the panel and off the edge of the screen.
 * This one opens next to the swatch and always stays inside the window.
 *
 * It takes over every <input type="color"> on the page: click (or Enter /
 * Space) opens it, and choosing a colour sets the input's value and fires the
 * same `input` and `change` events the browser picker would, so existing
 * handlers (dirty flags, optional-colour fields, live preview) work unchanged.
 */

const PRESETS = [
  '#ffc107', '#f59e0b', '#ea580c', '#dc2626', '#be185d', '#9333ea',
  '#4f46e5', '#2563eb', '#44739e', '#0891b2', '#0d9488', '#16a34a',
  '#3a8c4f', '#65a30d', '#a16207', '#78716c', '#6b7280', '#111111',
  '#ffffff', '#f5f5f0', '#d4d2cc', '#8c4f4f', '#4a6a2e', '#b33a2e'
];

let pop = null;       // the open popover
let target = null;    // the <input type="color"> it edits
let hsv = { h: 0, s: 0, v: 0 };

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(x => ('0' + Math.round(x).toString(16)).slice(-2)).join('');
}
function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
function hsvToRgb({ h, s, v }) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function apply(hex, { fromHexField = false } = {}) {
  if (!target) return;
  target.value = hex;
  // These events come from a person using the picker, but browsers mark
  // script-dispatched events untrusted: the tag lets Settings count them.
  target.dataset.colorPickerEdit = '1';
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  delete target.dataset.colorPickerEdit;
  render({ fromHexField });
}

function render({ fromHexField = false } = {}) {
  if (!pop) return;
  const hex = rgbToHex(hsvToRgb(hsv));
  pop.querySelector('.ecp-sv').style.backgroundColor = `hsl(${hsv.h}, 100%, 50%)`;
  const knob = pop.querySelector('.ecp-sv-knob');
  knob.style.left = `${hsv.s * 100}%`;
  knob.style.top = `${(1 - hsv.v) * 100}%`;
  pop.querySelector('.ecp-hue').value = String(Math.round(hsv.h));
  pop.querySelector('.ecp-current').style.backgroundColor = hex;
  if (!fromHexField) pop.querySelector('.ecp-hex').value = hex;
  pop.querySelectorAll('.ecp-preset').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === hex)));
}

/** Place the popover by the swatch, flipped and clamped to stay in the window. */
function place(anchor) {
  const gap = 6, margin = 8;
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let left = a.right - w;                       // right-align to the swatch
  if (left < margin) left = a.left;             // or left-align
  left = clamp(left, margin, Math.max(margin, vw - w - margin));
  let top = a.bottom + gap;
  if (top + h > vh - margin && a.top - gap - h >= margin) top = a.top - gap - h; // flip above
  top = clamp(top, margin, Math.max(margin, vh - h - margin));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function close({ refocus = true } = {}) {
  if (!pop) return;
  const t = target;
  pop.remove();
  pop = null;
  target = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onReflow);
  window.removeEventListener('scroll', onReflow, true);
  if (refocus && t && t.isConnected) t.focus();
}
function onOutside(e) { if (pop && !pop.contains(e.target) && e.target !== target) close({ refocus: false }); }
function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
function onReflow() { if (pop && target && target.isConnected) place(target); else close({ refocus: false }); }

function open(input) {
  close({ refocus: false });
  target = input;
  hsv = rgbToHsv(hexToRgb(input.value) || { r: 136, g: 136, b: 136 });
  pop = document.createElement('div');
  pop.className = 'ecp';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Choose a colour');
  pop.innerHTML =
    '<div class="ecp-sv" aria-hidden="true"><div class="ecp-sv-white"></div><div class="ecp-sv-black"></div><span class="ecp-sv-knob"></span></div>' +
    '<div class="ecp-row"><span class="ecp-current" aria-hidden="true"></span>' +
      '<input type="range" class="ecp-hue" min="0" max="360" step="1" aria-label="Hue"></div>' +
    '<div class="ecp-row"><label class="ecp-hex-label">Hex <input type="text" class="ecp-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Hex colour"></label></div>' +
    '<div class="ecp-presets" role="group" aria-label="Preset colours">' +
      PRESETS.map(c => `<button type="button" class="ecp-preset" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('') +
    '</div>';
  document.body.appendChild(pop);
  render();
  place(input);

  const sv = pop.querySelector('.ecp-sv');
  const pickSV = (e) => {
    const r = sv.getBoundingClientRect();
    hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    hsv.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    apply(rgbToHex(hsvToRgb(hsv)));
  };
  sv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sv.setPointerCapture(e.pointerId);
    pickSV(e);
    const move = (ev) => pickSV(ev);
    const up = () => { sv.removeEventListener('pointermove', move); sv.removeEventListener('pointerup', up); };
    sv.addEventListener('pointermove', move);
    sv.addEventListener('pointerup', up);
  });
  pop.querySelector('.ecp-hue').addEventListener('input', (e) => { hsv.h = Number(e.target.value); apply(rgbToHex(hsvToRgb(hsv))); });
  pop.querySelector('.ecp-hex').addEventListener('input', (e) => {
    let v = e.target.value.trim();
    if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
    const rgb = hexToRgb(v);
    if (!rgb) return;
    hsv = rgbToHsv(rgb);
    apply(v.toLowerCase(), { fromHexField: true });
  });
  pop.querySelector('.ecp-presets').addEventListener('click', (e) => {
    const b = e.target.closest('.ecp-preset');
    if (!b) return;
    hsv = rgbToHsv(hexToRgb(b.dataset.color));
    apply(b.dataset.color);
  });
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onReflow);
  window.addEventListener('scroll', onReflow, true);
  pop.querySelector('.ecp-hex').focus();
}

/** Take over every colour input on the page (now and added later). */
export function initColorPicker(root = document) {
  root.addEventListener('click', (e) => {
    const input = e.target.closest && e.target.closest('input[type="color"]');
    if (!input || input.disabled) return;
    e.preventDefault(); // no browser popup
    if (pop && target === input) close(); else open(input);
  });
  root.addEventListener('keydown', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'color') return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    open(input);
  });
}
