'use strict';
/**
 * A dashboard's own look (its `appearance`): background colours and image, transparent blocks,
 * square corners and glass. Anything a dashboard leaves out follows Settings → Appearance.
 *
 * The layout editor's "Dashboard style" panel sets it. The dashboards are saved as one list that
 * the page also reads without signing in, so only values that pass these rules are kept: colours as
 * #rrggbb, the image address without the characters that could end its CSS url("…"), booleans as
 * booleans, and the glass numbers inside their ranges. The same rules are in public/js/appearance.js
 * (cleanOverrides); test/dashboard-appearance.test.js checks that they agree.
 *
 * @module dashboardAppearance
 */

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null; };
const safeImageUrl = value => String(value == null ? '' : value).replace(/["'()\\\n\r]/g, '').trim().slice(0, 2048);

/** The valid overrides of a dashboard, or undefined when there are none. */
function sanitizeAppearance(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (typeof raw.bgLight === 'string' && HEX.test(raw.bgLight)) out.bgLight = raw.bgLight.toLowerCase();
  if (typeof raw.bgDark === 'string' && HEX.test(raw.bgDark)) out.bgDark = raw.bgDark.toLowerCase();
  if (typeof raw.bgImage === 'string') out.bgImage = safeImageUrl(raw.bgImage);   // '' = no image on this dashboard
  for (const key of ['transparentBlocks', 'squareCorners', 'glassCards']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  const blur = raw.glassBlur == null ? null : clamp(raw.glassBlur, 0, 40);
  if (blur !== null) out.glassBlur = blur;
  const frost = raw.glassFrost == null ? null : clamp(raw.glassFrost, 20, 200);
  if (frost !== null) out.glassFrost = frost;
  return Object.keys(out).length ? out : undefined;
}

/** Keep only valid appearance overrides on each dashboard of a config about to be saved. */
function sanitizeDashboards(config) {
  if (!config || !Array.isArray(config.dashboards)) return config;
  for (const dashboard of config.dashboards) {
    if (!dashboard || typeof dashboard !== 'object') continue;
    const clean = sanitizeAppearance(dashboard.appearance);
    if (clean) dashboard.appearance = clean; else delete dashboard.appearance;
  }
  return config;
}

module.exports = { sanitizeAppearance, sanitizeDashboards };
