/**
 * Where a dashboard's blocks go: the grid they are placed on, and the position and size of each block.
 *
 * A dashboard is laid out on a grid of `columns` across the width and rows of `rowHeight` px, with
 * `gap` px on each side of a block (blocks sit 2 × gap apart). Every dashboard has used 12 columns,
 * 50 px rows and a gap of 1 px so far; that is STANDARD_GRID, and a dashboard that says nothing
 * about its grid is placed on it exactly as before.
 *
 * Shared by the dashboard page (dashboard.js) and, later, the layout editor, so both place blocks
 * the same way. test/layout-grid.test.js holds a copy of the original dashboard.js placement and
 * checks that this module gives the same results for the default and sample layouts.
 *
 * @module layoutGrid
 */

export const STANDARD_GRID = Object.freeze({ columns: 12, rowHeight: 50, gap: 1, free: false, overlap: false });

/** The grid a dashboard is placed on (STANDARD_GRID unless it sets its own). */
export function gridOf(dashboard) {
  return STANDARD_GRID;
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
  const { columns, rowHeight, gap } = grid;
  return {
    left: `calc(${(item.x / columns) * 100}% + ${gap}px)`,
    top: `${item.top * rowHeight + gap}px`,
    width: `calc(${(item.w / columns) * 100}% - ${gap * 2}px)`,
    height: `${item.h * rowHeight - gap * 2}px`
  };
}

/** The height of the area the blocks are placed in, in px. */
export function areaHeight(placed, grid = STANDARD_GRID) {
  let bottom = 0;
  for (const item of placed) bottom = Math.max(bottom, (item.top + item.h) * grid.rowHeight);
  return bottom;
}
