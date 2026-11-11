/**
 * A dashboard's look: background colours and image, transparent blocks, square corners and glass.
 *
 * Settings → Appearance holds the defaults for every dashboard. A dashboard can override any of them
 * (its `appearance`, set in the layout editor's "Dashboard style" panel); what it leaves out follows the
 * defaults. Title, logo and favicon are not part of this: they stay the same on every dashboard.
 *
 * Shared by the dashboard page and the layout editor, so the editor's preview is the real look. The
 * rules in cleanOverrides() are repeated in modules/dashboardAppearance.js (the server keeps only what
 * passes them); test/dashboard-appearance.test.js checks that the two agree.
 *
 * @module appearance
 */

export const FIELDS = ['bgLight', 'bgDark', 'bgImage', 'transparentBlocks', 'squareCorners', 'glassCards', 'glassBlur', 'glassFrost'];

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null; };
const num = (v, lo, hi, fallback) => { if (v === '' || v == null) return fallback; const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };   // an empty setting is not 0

/** A background image address with the characters that could end its CSS url("…") taken out. */
export function safeImageUrl(value) {
  return String(value == null ? '' : value).replace(/["'()\\\n\r]/g, '').trim().slice(0, 2048);
}

/** The defaults, from the public settings (Settings → Appearance). */
export function globalAppearance(cfg = {}) {
  return {
    bgLight: HEX.test(cfg.dashboard_bg_color_light || '') ? cfg.dashboard_bg_color_light : (HEX.test(cfg.dashboard_bg_color || '') ? cfg.dashboard_bg_color : '#f8fafc'),
    bgDark: HEX.test(cfg.dashboard_bg_color_dark || '') ? cfg.dashboard_bg_color_dark : '#0f172a',
    bgImage: safeImageUrl(cfg.dashboard_bg_image),
    transparentBlocks: cfg.transparent_blocks === 'true',
    squareCorners: cfg.square_corners === 'true',
    glassCards: cfg.glass_cards === 'true',
    glassBlur: num(cfg.glass_blur, 0, 40, 18),
    glassFrost: num(cfg.glass_frost, 20, 200, 100)
  };
}

/** Only the valid overrides of a dashboard, by name; an empty object when it has none. */
export function cleanOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.bgLight === 'string' && HEX.test(raw.bgLight)) out.bgLight = raw.bgLight.toLowerCase();
  if (typeof raw.bgDark === 'string' && HEX.test(raw.bgDark)) out.bgDark = raw.bgDark.toLowerCase();
  if (typeof raw.bgImage === 'string') out.bgImage = safeImageUrl(raw.bgImage);   // '' = no image on this dashboard
  for (const key of ['transparentBlocks', 'squareCorners', 'glassCards']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  const blur = raw.glassBlur == null ? null : clamp(raw.glassBlur, 0, 40);
  if (blur !== null) out.glassBlur = blur;
  const frost = raw.glassFrost == null ? null : clamp(raw.glassFrost, 20, 200);
  if (frost !== null) out.glassFrost = frost;
  return out;
}

/** What a dashboard looks like: the defaults, with its own overrides on top. */
export function effectiveAppearance(base, overrides) {
  return Object.assign({}, base, cleanOverrides(overrides));
}

let painted = null;   // { el, look, fixed, anchored }: what the background was last painted on, for a theme change

// A picture anchored to the layout area (a dashboard that scales to the screen width, see layoutGrid.js).
// The area gets `--pic-url` and `--pic-ratio` (width over height) and the class `has-picture` once the
// picture is known to load; the stylesheets (style.css, editor.css) draw it from those, as wide as the area,
// from its top left, so a block sits on the same part of the picture whatever the screen or window.
const ratios = new Map();
function pictureRatio(url) {
  if (ratios.has(url)) return Promise.resolve(ratios.get(url));
  return new Promise(resolve => {
    if (typeof Image !== 'function') { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null;
      if (ratio) ratios.set(url, ratio);
      resolve(ratio);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
function clearAnchored(el) {
  if (!el) return;
  el.classList.remove('has-picture');
  el.style.removeProperty('--pic-url');
  el.style.removeProperty('--pic-ratio');
}
function paintAnchored(el, url) {
  if (!url) { clearAnchored(el); return; }
  const wanted = `url("${url}")`;
  el.style.setProperty('--pic-url', wanted);
  pictureRatio(url).then(ratio => {
    if (!ratio || el.style.getPropertyValue('--pic-url') !== wanted) return;   // it failed, or the picture changed meanwhile
    el.style.setProperty('--pic-ratio', String(ratio));
    el.classList.add('has-picture');
  });
}

/** The background colour for the theme now in use. */
function backgroundFor(look) {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? look.bgDark : look.bgLight;
}

function paintBackground(el, look, fixed, anchored) {
  el.style.backgroundColor = backgroundFor(look) || '';
  if (look.bgImage && !(anchored && !anchored.fallback)) {
    el.style.backgroundImage = `url("${look.bgImage}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.backgroundAttachment = fixed ? 'fixed' : 'scroll';
  } else {
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    el.style.backgroundAttachment = '';
  }
}

let watching = false;
function watchTheme() {
  if (watching || typeof document === 'undefined' || !document.body) return;
  watching = true;
  document.body.addEventListener('theme-changed', () => { if (painted) paintBackground(painted.el, painted.look, painted.fixed, painted.anchored); });
}

/**
 * Put a look on the page. The classes and glass numbers go on <body> (the card styles in style.css and
 * glass.css key off them); the background goes on `backgroundEl` (the page itself, or the editor's canvas).
 * Glass replaces the transparent-blocks look, as it always has.
 *
 * With `anchored` ({ el, fallback }) the picture is drawn on that element, the layout area, instead of on
 * `backgroundEl`; with `fallback` it is also kept on `backgroundEl` (the dashboard hides that one on wide
 * screens in CSS and shows it on phones, where the blocks stack and there is no area to anchor to).
 */
export function applyAppearance(look, { backgroundEl = document.body, fixed = true, anchored = null } = {}) {
  const body = document.body;
  body.classList.toggle('square-corners', !!look.squareCorners);
  body.classList.toggle('glass-cards', !!look.glassCards);
  body.classList.toggle('transparent-blocks', !!look.transparentBlocks && !look.glassCards);
  if (look.glassCards) {
    body.style.setProperty('--glass-blur', `${num(look.glassBlur, 0, 40, 18)}px`);
    body.style.setProperty('--glass-frost', String(num(look.glassFrost, 20, 200, 100) / 100));
  } else {
    body.style.removeProperty('--glass-blur');
    body.style.removeProperty('--glass-frost');
  }
  if (painted && painted.anchored && (!anchored || painted.anchored.el !== anchored.el)) clearAnchored(painted.anchored.el);
  painted = { el: backgroundEl, look, fixed, anchored };
  paintBackground(backgroundEl, look, fixed, anchored);
  if (anchored) paintAnchored(anchored.el, look.bgImage);
  watchTheme();
}

/** Take a look off: no classes, and the background back to the page's own. */
export function clearAppearance({ backgroundEl = document.body } = {}) {
  const body = document.body;
  body.classList.remove('square-corners', 'glass-cards', 'transparent-blocks');
  body.style.removeProperty('--glass-blur');
  body.style.removeProperty('--glass-frost');
  for (const prop of ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundAttachment']) backgroundEl.style[prop] = '';
  if (painted && painted.el === backgroundEl) {
    if (painted.anchored) clearAnchored(painted.anchored.el);
    painted = null;
  }
}
