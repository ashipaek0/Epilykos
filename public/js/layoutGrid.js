/**
 * Where a dashboard's blocks go: the grid they are placed on, and the position and size of each block.
 *
 * A dashboard is laid out on a grid of `columns` across the width and rows of `rowHeight` px, with
 * `gap` px between blocks (half of it on each side of a block). Every dashboard has used 12 columns,
 * 50 px rows and a gap of 2 px so far; that is STANDARD_GRID, and a dashboard that says nothing
 * about its grid (no `grid` on it) is placed on it exactly as before.
 *
 * Shared by the dashboard page (dashboard.js) and, later, the layout editor, so both place blocks
 * the same way. test/layout-grid.test.js holds a copy of the original dashboard.js placement and
 * checks that this module gives the same results for the default and sample layouts.
 *
 * @module layoutGrid
 */

/**
 * The precisions a dashboard can be placed at: columns across the width, and the row height that
 * keeps a row the same height as before (every one is an exact multiple of the standard grid, so a
 * layout can be rescaled to a finer one without moving anything).
 */
export const PRECISIONS = Object.freeze([
  Object.freeze({ id: 'standard', label: 'Standard', columns: 12, rowHeight: 50 }),
  Object.freeze({ id: 'fine', label: 'Fine', columns: 24, rowHeight: 25 }),
  Object.freeze({ id: 'finer', label: 'Finer', columns: 60, rowHeight: 10 })
]);
export const MAX_GAP = 24;

/** `gap` is the space between two blocks in px (each block keeps half of it on its sides). */
export const STANDARD_GRID = Object.freeze({ columns: 12, rowHeight: 50, gap: 2, free: false, overlap: false });

/**
 * The valid grid settings of a dashboard, by name (an empty object when it sets none):
 * columns (one of the precisions above), gap (0 to MAX_GAP px), free and overlap (booleans).
 * The row height follows from the columns. The same rules are in modules/dashboardGrid.js, which
 * keeps only these when dashboards are saved; test/dashboard-grid.test.js checks they agree.
 */
export function cleanGrid(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const precision = PRECISIONS.find(p => p.columns === raw.columns);
  if (precision) { out.columns = precision.columns; out.rowHeight = precision.rowHeight; }
  const gap = Number(raw.gap);
  if (raw.gap !== '' && raw.gap != null && Number.isFinite(gap)) out.gap = Math.min(MAX_GAP, Math.max(0, Math.round(gap)));
  if (typeof raw.free === 'boolean') out.free = raw.free;
  if (typeof raw.overlap === 'boolean') out.overlap = raw.overlap;
  return out;
}

/** The grid a dashboard is placed on: its own settings over the standard grid. */
export function gridOf(dashboard) {
  const own = cleanGrid(dashboard && dashboard.grid);
  return Object.keys(own).length ? Object.freeze({ ...STANDARD_GRID, ...own }) : STANDARD_GRID;
}

/** The precision a grid is at. */
export function precisionOf(grid) {
  return PRECISIONS.find(p => p.columns === grid.columns) || PRECISIONS[0];
}

/**
 * Give each block its top row. Blocks are taken top to bottom, then left to right; a block that
 * would overlap an earlier one in the columns they share is moved down below it (so two blocks are
 * never drawn on top of each other). With grid.overlap set, blocks stay where they are saved.
 * @param {Array<{x:number,y:number,w:number,h:number}>} items
 * @returns the same items, sorted, each with `top` (its row on the page)
 */
export function placeBlocks(items, grid = STANDARD_GRID) {
  const placed = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < placed.length; i++) {
    const cur = placed[i];
    let top = cur.y;
    if (!grid.overlap) {
      for (let j = 0; j < i; j++) {
        const prev = placed[j];
        if (cur.x + cur.w > prev.x && cur.x < prev.x + prev.w) {
          const prevBottom = prev.top + prev.h;
          if (top < prevBottom) top = prevBottom;
        }
      }
    }
    cur.top = top;
  }
  return placed;
}

/** The CSS position and size of a placed block, in the dashboard's own units. */
export function blockStyle(item, grid = STANDARD_GRID) {
  const { columns, rowHeight } = grid, side = grid.gap / 2;   // half the space between blocks on each side
  return {
    left: `calc(${(item.x / columns) * 100}% + ${side}px)`,
    top: `${item.top * rowHeight + side}px`,
    width: `calc(${(item.w / columns) * 100}% - ${side * 2}px)`,
    height: `${item.h * rowHeight - side * 2}px`
  };
}

/** The height of the area the blocks are placed in, in px. */
export function areaHeight(placed, grid = STANDARD_GRID) {
  let bottom = 0;
  for (const item of placed) bottom = Math.max(bottom, (item.top + item.h) * grid.rowHeight);
  return bottom;
}
