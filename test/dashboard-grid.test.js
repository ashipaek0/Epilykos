'use strict';
const checks = require('./_checks');
/**
 * A dashboard can carry its own grid: precision (columns across the width, rows that keep their
 * height), the space between blocks, free placement and overlap. With none, it is on the standard
 * grid (12 columns, 50 px rows, 2 px apart) exactly as every dashboard has been.
 * - the page and the server keep only valid values, by the same rules;
 * - a dashboard's grid is its own settings over the standard grid;
 * - the same layout, doubled, on the finer grid is placed identically;
 * - saving (and so importing) keeps only a valid grid;
 * - the dashboard page places blocks on the dashboard's grid.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('node:url');
const REPO = path.join(__dirname, '..');

(async () => {
  const M = await import(pathToFileURL(path.join(REPO, 'public/js/layoutGrid.js')).href);
  const S = require('../modules/dashboardGrid');

  // The rules.
  const input = { columns: 24, rowHeight: 999, gap: 7.4, free: true, overlap: 'yes', other: 1 };
  assert.deepStrictEqual(M.cleanGrid(input), { columns: 24, rowHeight: 25, gap: 7, free: true }, 'the row height follows the columns');
  assert.deepStrictEqual(S.sanitizeGrid(input), M.cleanGrid(input), 'the server and the page keep the same');
  for (const [raw, want] of [
    [{ columns: 12 }, { columns: 12, rowHeight: 50 }], [{ columns: 60 }, { columns: 60, rowHeight: 10 }],
    [{ columns: 13 }, {}], [{ columns: '24' }, {}], [{ columns: 120 }, {}],
    [{ gap: 99 }, { gap: 24 }], [{ gap: -5 }, { gap: 0 }], [{ gap: '' }, {}], [{ gap: null }, {}], [{ gap: 'a' }, {}], [{ gap: 0 }, { gap: 0 }],
    [{ free: false, overlap: true }, { free: false, overlap: true }], [{ free: 1 }, {}],
    [null, {}], [undefined, {}], ['x', {}], [5, {}], [[], {}], [{}, {}]
  ]) {
    assert.deepStrictEqual(M.cleanGrid(raw), want, JSON.stringify(raw));
    assert.deepStrictEqual(S.sanitizeGrid(raw) || {}, want, 'server: ' + JSON.stringify(raw));
  }
  assert.deepStrictEqual(M.PRECISIONS.map(p => [p.columns, p.rowHeight]), S.PRECISIONS.map(p => [p.columns, p.rowHeight]), 'the same precisions');
  for (const p of M.PRECISIONS) assert.ok(p.columns % 12 === 0 && 50 % (p.columns / 12) === 0 && p.rowHeight === 50 / (p.columns / 12), `${p.id} is an exact multiple of the standard grid`);
  console.log('ok - only valid values are kept, by the same rules on the page and the server');

  // The grid of a dashboard.
  assert.strictEqual(M.gridOf({ id: 'a' }), M.STANDARD_GRID); assert.strictEqual(M.gridOf({ grid: {} }), M.STANDARD_GRID);
  assert.strictEqual(M.gridOf({ grid: { columns: 99, gap: 'x' } }), M.STANDARD_GRID, 'nothing valid: the standard grid');
  assert.deepStrictEqual({ ...M.gridOf({ grid: { columns: 60, gap: 0, overlap: true } }) }, { columns: 60, rowHeight: 10, gap: 0, free: false, overlap: true });
  assert.deepStrictEqual({ ...M.gridOf({ grid: { gap: 8 } }) }, { columns: 12, rowHeight: 50, gap: 8, free: false, overlap: false }, 'what it leaves out is standard');
  assert.strictEqual(M.precisionOf(M.gridOf({ grid: { columns: 24 } })).id, 'fine'); assert.strictEqual(M.precisionOf(M.STANDARD_GRID).id, 'standard');
  console.log('ok - a dashboard is on its own grid over the standard one');

  // The same layout on a finer grid.
  const place = (layout, grid) => {
    const items = layout.map(b => ({ block: b, x: b.gridX, y: b.gridY, w: b.gridW, h: b.gridH }));
    return M.placeBlocks(items, grid).map(i => ({ id: i.block.id, ...M.blockStyle(i, grid) }));
  };
  const base = [{ id: 'a', gridX: 0, gridY: 0, gridW: 6, gridH: 4 }, { id: 'b', gridX: 6, gridY: 1, gridW: 6, gridH: 3 }, { id: 'c', gridX: 2, gridY: 3, gridW: 8, gridH: 2 }];
  for (const p of M.PRECISIONS) {
    const k = p.columns / 12;
    const scaled = base.map(b => ({ id: b.id, gridX: b.gridX * k, gridY: b.gridY * k, gridW: b.gridW * k, gridH: b.gridH * k }));
    // rows are 50/k px tall and there are k times as many, so a scaled layout is the same on the page
    assert.deepStrictEqual(place(scaled, M.gridOf({ grid: { columns: p.columns } })), place(base, M.STANDARD_GRID), p.id);
  }
  assert.strictEqual(M.blockStyle({ x: 0, top: 0, w: 12, h: 2 }, { ...M.STANDARD_GRID, gap: 7 }).width, 'calc(100% - 7px)', 'the gap is the space between blocks, half on each side');
  assert.strictEqual(M.blockStyle({ x: 0, top: 0, w: 12, h: 2 }, { ...M.STANDARD_GRID, gap: 0 }).left, 'calc(0% + 0px)');
  console.log('ok - a layout scaled to a finer precision is placed identically; the gap is the space between blocks');

  // Saving and importing.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-dashgrid-'));
  process.chdir(tmp); process.env.ENC_KEY_FILE = path.join(tmp, 'key');
  const database = require('../modules/database'); database.initializeDatabase();
  const { saveDashboardConfig, getDashboardConfig } = require('../modules/dashboard-config');
  saveDashboardConfig({ dashboards: [
    { id: 'a', name: 'A', layout: [], grid: { columns: 60, rowHeight: 7, gap: 99, evil: '<x>', free: true }, appearance: { bgLight: '#ffcc00' } },
    { id: 'b', name: 'B', layout: [], grid: { columns: 17 } },
    { id: 'c', name: 'C', layout: [] }
  ], activeDashboard: 'a' });
  const saved = getDashboardConfig().dashboards;
  assert.deepStrictEqual(saved[0].grid, { columns: 60, rowHeight: 10, gap: 24, free: true });
  assert.deepStrictEqual(saved[0].appearance, { bgLight: '#ffcc00' }, 'the look is kept beside it');
  assert.ok(!('grid' in saved[1]) && !('grid' in saved[2]), 'nothing valid: no grid at all');
  console.log('ok - saving keeps only a valid grid');

  // The page places blocks on the dashboard's grid.
  const dash = fs.readFileSync(path.join(REPO, 'public/js/dashboard.js'), 'utf8');
  assert.match(dash, /const grid = gridOf\(active\);/); assert.match(dash, /placeBlocks\(positioned, grid\)/);
  assert.match(dash, /blockStyle\(item, grid\)/); assert.match(dash, /areaHeight\(rendered, grid\)/);
  assert.match(dash, /w: block\.gridW \?\? grid\.columns/, 'a block with no width is as wide as the dashboard');
  console.log('ok - the dashboard page places blocks on the dashboard\'s grid');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
