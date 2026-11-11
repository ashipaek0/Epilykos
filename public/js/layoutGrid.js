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

/**
 * The width, in px, at which a dashboard's rows and gap are their stated size when it scales to the
 * screen width (grid.scale). It is the widest the dashboard's block area gets (the page is 1400 px at
 * most), so on a large screen a scaled dashboard looks exactly as an unscaled one; on a narrower one
 * every row, the gap and the picture behind shrink with the width. Phones (under 769 px) stack the
 * blocks and are not scaled.
 */
export const SCALE_REFERENCE_WIDTH = 1400;

/** `gap` is the space between two blocks in px (each block keeps half of it on its sides). */
export const STANDARD_GRID = Object.freeze({ columns: 12, rowHeight: 50, gap: 2, free: false, overlap: false, scale: false });

/**
 * The valid grid settings of a dashboard, by name (an empty object when it sets none):
 * columns (one of the precisions above), gap (0 to MAX_GAP px), free, overlap and scale (booleans).
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
  if (typeof raw.scale === 'boolean') out.scale = raw.scale;
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

/**
 * The CSS position and size of a placed block, in the dashboard's own units. When the dashboard scales to
 * the screen width (grid.scale), every length in px is multiplied by --s, the area's width over
 * SCALE_REFERENCE_WIDTH (set on the area by dashboard.js); columns are already a share of the width.
 */
export function blockStyle(item, grid = STANDARD_GRID) {
  const { columns, rowHeight } = grid, side = grid.gap / 2;   // half the space between blocks on each side
  if (grid.scale) {
    const px = n => `calc(${n}px * var(--s, 1))`;
    return {
      left: `calc(${(item.x / columns) * 100}% + ${px(side)})`,
      top: px(item.top * rowHeight + side),
      width: `calc(${(item.w / columns) * 100}% - ${px(side * 2)})`,
      height: px(item.h * rowHeight - side * 2)
    };
  }
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

/**
 * Move a layout to another precision without moving anything on the page: columns and rows scale by
 * the same ratio (a row is 50 × 12 / columns px tall). Going finer is exact. Going coarser rounds to
 * the nearest cell (a block is never made smaller than one cell, nor pushed past the right edge), and
 * the blocks that had to move are counted so the editor can say so. Changes the blocks in place.
 * @param {Array<{gridX:number,gridY:number,gridW:number,gridH:number}>} layout
 * @returns {number} how many blocks could not keep their exact place and size
 */
export function rescaleLayout(layout, fromColumns, toColumns) {
  if (!(fromColumns > 0) || !(toColumns > 0) || fromColumns === toColumns) return 0;
  const ratio = toColumns / fromColumns;
  const exact = v => Math.abs(v * ratio - Math.round(v * ratio)) < 1e-9;
  let inexact = 0;
  for (const block of layout) {
    const parts = ['gridX', 'gridY', 'gridW', 'gridH'];
    if (!parts.every(k => Number.isFinite(Number(block[k])))) continue;
    if (!parts.every(k => exact(Number(block[k])))) inexact++;
    const w = Math.min(toColumns, Math.max(1, Math.round(block.gridW * ratio)));
    block.gridW = w;
    block.gridX = Math.max(0, Math.min(toColumns - w, Math.round(block.gridX * ratio)));
    block.gridY = Math.max(0, Math.round(block.gridY * ratio));
    block.gridH = Math.max(1, Math.round(block.gridH * ratio));
  }
  return inexact;
}

/**
 * How many blocks have empty space above them that a layout packed upward would close: the blocks a
 * dashboard without free placement moves up when the layout editor packs it (see editor.js). The
 * dashboard page never does, so these are where its blocks and the editor's could differ.
 * @param {Array<{gridX:number,gridY:number,gridW:number,gridH:number}>} layout
 */
export function looseBlocks(layout) {
  const boxes = layout
    .map(b => ({ x: Number(b.gridX), y: Number(b.gridY), w: Number(b.gridW), h: Number(b.gridH) }))
    .filter(b => [b.x, b.y, b.w, b.h].every(Number.isFinite));
  let loose = 0;
  for (const b of boxes) {
    let rest = 0;   // the lowest edge above it that it would come to rest on
    for (const o of boxes) {
      if (o === b || o.y + o.h > b.y || !(b.x + b.w > o.x && b.x < o.x + o.w)) continue;
      rest = Math.max(rest, o.y + o.h);
    }
    if (b.y > rest) loose++;
  }
  return loose;
}

/** A library block's size (given for the standard grid) on a grid. */
export function sizeOnGrid(info, grid) {
  const k = grid.columns / STANDARD_GRID.columns;
  return { w: Math.min(grid.columns, Math.max(1, Math.round(info.w * k))), h: Math.max(1, Math.round(info.h * k)) };
}
