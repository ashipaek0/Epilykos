'use strict';
/**
 * A dashboard's grid: how finely its blocks are placed (columns across the width, and rows that
 * stay the same height), the space between blocks, free placement (no packing upward in the layout
 * editor) and overlap (blocks may sit on top of each other instead of being moved apart).
 *
 * A dashboard with no `grid` is on the standard grid, 12 columns and 50 px rows, as every dashboard
 * has been. The layout editor sets it. Only values that pass these rules are kept when dashboards are
 * saved or imported. The same rules are in public/js/layoutGrid.js (cleanGrid); test/dashboard-grid.test.js
 * checks that they agree.
 *
 * @module dashboardGrid
 */

// columns -> row height: each is an exact multiple of the standard 12 x 50.
const PRECISIONS = [{ columns: 12, rowHeight: 50 }, { columns: 24, rowHeight: 25 }, { columns: 60, rowHeight: 10 }];
const MAX_GAP = 24;

/** The valid grid settings of a dashboard, or undefined when it has none. */
function sanitizeGrid(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  const precision = PRECISIONS.find(p => p.columns === raw.columns);
  if (precision) { out.columns = precision.columns; out.rowHeight = precision.rowHeight; }
  const gap = Number(raw.gap);
  if (raw.gap !== '' && raw.gap != null && Number.isFinite(gap)) out.gap = Math.min(MAX_GAP, Math.max(0, Math.round(gap)));
  if (typeof raw.free === 'boolean') out.free = raw.free;
  if (typeof raw.overlap === 'boolean') out.overlap = raw.overlap;
  if (typeof raw.scale === 'boolean') out.scale = raw.scale;
  return Object.keys(out).length ? out : undefined;
}

/** Keep only a valid grid on each dashboard of a config about to be saved. */
function sanitizeGrids(config) {
  if (!config || !Array.isArray(config.dashboards)) return config;
  for (const dashboard of config.dashboards) {
    if (!dashboard || typeof dashboard !== 'object') continue;
    const clean = sanitizeGrid(dashboard.grid);
    if (clean) dashboard.grid = clean; else delete dashboard.grid;
  }
  return config;
}

module.exports = { sanitizeGrid, sanitizeGrids, PRECISIONS, MAX_GAP };
