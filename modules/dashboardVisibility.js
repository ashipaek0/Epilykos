'use strict';
/**
 * Which dashboards a visitor (no session) may see. The ones chosen as the default on computers and on
 * phones are visible; every other dashboard is hidden until it is expressly enabled in Settings
 * (the `public_dashboards` list). A signed-in session always gets all of them.
 *
 * The visitor's copy of the config is filtered here, on the server, so a hidden dashboard's layout is never
 * sent to them: hiding a tab in the page alone would leave it one request away.
 */

function parseIds(raw) {
  if (Array.isArray(raw)) return raw.filter(x => typeof x === 'string');
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
}

/** The ids a visitor may see, in dashboard order. Never empty while there is a dashboard. */
function visibleIds(config, { desktop, mobile, extra } = {}) {
  const dashboards = (config && config.dashboards) || [];
  if (dashboards.length === 0) return [];
  const have = new Set(dashboards.map(d => d.id));
  // "Default" in Settings means whichever dashboard was last shown (activeDashboard), else the first.
  const fallback = have.has(config.activeDashboard) ? config.activeDashboard : dashboards[0].id;
  const wanted = new Set();
  wanted.add(have.has(desktop) ? desktop : fallback);
  wanted.add(have.has(mobile) ? mobile : fallback);
  for (const id of parseIds(extra)) if (have.has(id)) wanted.add(id);
  return dashboards.map(d => d.id).filter(id => wanted.has(id));
}

/** The config as a visitor may see it: only the visible dashboards, and an active one that is among them. */
function forVisitor(config, settings) {
  const ids = visibleIds(config, settings);
  const keep = new Set(ids);
  const dashboards = config.dashboards.filter(d => keep.has(d.id));
  const activeDashboard = keep.has(config.activeDashboard) ? config.activeDashboard : (ids[0] || config.activeDashboard);
  return { ...config, dashboards, activeDashboard };
}

module.exports = { visibleIds, forVisitor, parseIds };
