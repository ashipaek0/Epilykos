'use strict';
const checks = require('./_checks');
/**
 * Placing a dashboard's blocks (public/js/layoutGrid.js) gives exactly what dashboard.js gave before
 * the placement moved there. `legacyPlace` below is that code, copied as it was, and every layout
 * here - the default dashboards and a few hundred random ones, overlapping blocks included - must come
 * out the same, pixel for pixel, through the module.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('node:url');
const REPO = path.join(__dirname, '..');

// The placement in dashboard.js before it moved to layoutGrid.js (12 columns, 50 px rows, gap 1).
function legacyPlace(layout) {
  const ROW_HEIGHT = 50, GAP = 1;
  const positioned = [];
  layout.forEach(block => {
    if (block.enabled === false) return;
    positioned.push({ block, x: block.gridX ?? 0, y: block.gridY ?? 0, w: block.gridW ?? 12, h: block.gridH ?? 4 });
  });
  positioned.sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < positioned.length; i++) {
    const cur = positioned[i];
    let adjustedY = cur.y;
    for (let j = 0; j < i; j++) {
      const prev = positioned[j];
      const curLeft = cur.x, curRight = cur.x + cur.w, prevLeft = prev.x, prevRight = prev.x + prev.w;
      if (curRight > prevLeft && curLeft < prevRight) {
        const prevBottom = prev._top + prev.h;
        if (adjustedY < prevBottom) adjustedY = prevBottom;
      }
    }
    cur._top = adjustedY;
  }
  let maxBottom = 0;
  const out = positioned.map(({ block, x, w, h, _top }) => {
    maxBottom = Math.max(maxBottom, (_top + h) * ROW_HEIGHT);
    return {
      id: block.id,
      left: `calc(${((x / 12) * 100)}% + ${GAP}px)`,
      top: (_top * ROW_HEIGHT + GAP) + 'px',
      width: `calc(${((w / 12) * 100)}% - ${GAP * 2}px)`,
      height: (h * ROW_HEIGHT - GAP * 2) + 'px'
    };
  });
  return { blocks: out, height: maxBottom };
}

function modulePlace(M, layout, grid) {
  const items = [];
  layout.forEach(block => {
    if (block.enabled === false) return;
    items.push({ block, x: block.gridX ?? 0, y: block.gridY ?? 0, w: block.gridW ?? 12, h: block.gridH ?? 4 });
  });
  const placed = M.placeBlocks(items, grid);
  return { blocks: placed.map(item => ({ id: item.block.id, ...M.blockStyle(item, grid) })), height: M.areaHeight(placed, grid) };
}

// A repeatable pseudo-random generator.
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

(async () => {
  const M = await import(pathToFileURL(path.join(REPO, 'public/js/layoutGrid.js')).href);
  assert.deepStrictEqual({ ...M.STANDARD_GRID }, { columns: 12, rowHeight: 50, gap: 1, free: false, overlap: false });
  assert.strictEqual(M.gridOf({ id: 'x' }), M.STANDARD_GRID, 'a dashboard that says nothing is on the standard grid');
  assert.strictEqual(M.gridOf(undefined), M.STANDARD_GRID);

  // The default dashboards, as a new install has them.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-grid-'));
  process.chdir(tmp); process.env.ENC_KEY_FILE = path.join(tmp, 'key');
  const database = require('../modules/database'); database.initializeDatabase();
  const defaults = require('../modules/dashboard-config').getDashboardConfig().dashboards;
  assert.ok(defaults.length >= 1 && defaults.some(d => d.layout.length > 3), 'there are default layouts to compare');
  let compared = 0;
  for (const dash of defaults) {
    assert.deepStrictEqual(modulePlace(M, dash.layout, M.gridOf(dash)), legacyPlace(dash.layout), `default dashboard ${dash.id}`);
    compared++;
  }
  console.log(`ok - ${compared} default dashboard(s) placed as before`);

  // Random layouts: overlaps, equal positions, hidden blocks, missing fields.
  const rand = rng(20261112);
  const pick = n => Math.floor(rand() * n);
  for (let t = 0; t < 400; t++) {
    const layout = [];
    for (let i = 0, n = 1 + pick(14); i < n; i++) {
      const block = { id: `b${i}`, type: 'x' };
      if (pick(10)) block.gridX = pick(12);
      if (pick(10)) block.gridY = pick(20);
      if (pick(10)) block.gridW = 1 + pick(12);
      if (pick(10)) block.gridH = 1 + pick(10);
      if (!pick(8)) block.enabled = false;
      layout.push(block);
    }
    assert.deepStrictEqual(modulePlace(M, layout, M.STANDARD_GRID), legacyPlace(layout), JSON.stringify(layout));
  }
  console.log('ok - 400 random layouts, overlapping ones included, are placed as before');

  // Nothing is changed on the way in, and an empty dashboard is an empty area.
  const layout = [{ id: 'a', gridX: 0, gridY: 2, gridW: 6, gridH: 3 }];
  const before = JSON.stringify(layout);
  modulePlace(M, layout, M.STANDARD_GRID);
  assert.strictEqual(JSON.stringify(layout), before);
  assert.deepStrictEqual(modulePlace(M, [], M.STANDARD_GRID), { blocks: [], height: 0 });
  console.log('ok - the layout is not changed, and an empty dashboard has no height');

  // The grid is a parameter (used from the next steps on): the same blocks on another grid.
  const fine = { columns: 24, rowHeight: 25, gap: 1, free: false, overlap: false };
  const std = modulePlace(M, [{ id: 'a', gridX: 3, gridY: 2, gridW: 6, gridH: 4 }], M.STANDARD_GRID).blocks[0];
  const dbl = modulePlace(M, [{ id: 'a', gridX: 6, gridY: 4, gridW: 12, gridH: 8 }], fine).blocks[0];
  assert.deepStrictEqual(dbl, std, 'a layout doubled on a grid twice as fine looks the same');
  const free = modulePlace(M, [{ id: 'a', gridX: 0, gridY: 0, gridW: 6, gridH: 4 }, { id: 'b', gridX: 3, gridY: 2, gridW: 6, gridH: 4 }], { ...fine, overlap: true });
  assert.strictEqual(free.blocks[1].top, `${2 * 25 + 1}px`, 'with overlap allowed a block stays where it is saved');
  const apart = modulePlace(M, [{ id: 'a', gridX: 0, gridY: 0, gridW: 6, gridH: 4 }, { id: 'b', gridX: 3, gridY: 2, gridW: 6, gridH: 4 }], fine);
  assert.strictEqual(apart.blocks[1].top, `${4 * 25 + 1}px`, 'otherwise it is moved below the one it overlaps');
  console.log('ok - another grid places the same layout the same way; overlap can be allowed');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
