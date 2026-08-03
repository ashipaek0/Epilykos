#!/usr/bin/env node
/**
 * Epilykos issue #64 — grid-hours regression test (manual, framework-free).
 *
 * Run:  node tests/grid-hours.test.js   (from anywhere; cwd is not touched)
 *
 * Covers the issue-#64 grid-hours assertions:
 *   AC1  text-state recording  (latest_metrics.value NULL + value_text='on')
 *   AC3  numeric hours math    (ON 00:10 -> OFF 01:10  => 1.0 h)
 *   AC4  midnight rollover     (pre-midnight ON carries into today;
 *                               still-ON-at-midnight counts from 00:00)
 *   AC5  00:01 supply          (ON 00:01 -> OFF 00:45  => ~0.73 h)
 *   AC6  2-minute precision    (ON 14:00 -> OFF 14:02  => 0.03 h, NOT 0 — D3 guard)
 *   AC7  multiple short events (07:02-07:04 + 07:05-07:09 => 6 min)
 *   AC8  zero day              (no rows today, last yesterday OFF => 0)
 *   AC9  unconfigured          (empty grid_status_entity => hours 0, configured:false)
 *   AC10 cross-pipeline        (history daily_grid_import present + ON rows today)
 *
 * DB-injection approach
 * ---------------------
 * modules/database.js hardcodes DB_PATH = './data/energy.db' and does NOT read
 * any env var, BUT the relative path is resolved by better-sqlite3 against
 * process.cwd() at `new Database(DB_PATH)` time (inside initializeDatabase()).
 * So this test:
 *   1. creates a fresh temp dir with a data/ subdir,
 *   2. process.chdir() into it  ->  './data/energy.db' now points at the temp DB,
 *   3. requires the repo's database module and calls initializeDatabase()
 *      (creates the real schema + seeds config there — no copy of the 3.1 GB
 *      production DB needed),
 *   4. requires the repo's grid module by absolute path (its internal
 *      require('./database') resolves to the same module instance),
 *   5. seeds grid_status / latest_metrics / history through the shared
 *      getDb() singleton — grid.js calls getDb() on every function call.
 *
 * Timezone handling: all seed timestamps are built with the LOCAL-time
 * constructor `new Date(y, m, d, h, mi, s)`, and "now" is frozen at
 * 18:00:00 LOCAL today (via a Date subclass), so the functions' `new Date()`
 * local-time logic sees a deterministic day in whatever TZ the host runs
 * (WAT on the target, but any TZ works).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..'); // /home/ashipa/epilykos-repo
const RealDate = global.Date;               // capture the real Date before freezing

// ---------------------------------------------------------------------------
// 1. Temp DB injection (see header comment)
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridtest-'));
fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
process.chdir(tmpDir);

const database = require(path.join(REPO, 'modules', 'database'));
database.initializeDatabase();               // builds fresh schema + config in tmpDir/data
const grid = require(path.join(REPO, 'modules', 'grid'));
const { getDb, setConfig } = database;
const db = getDb();

process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

// ---------------------------------------------------------------------------
// 2. Freeze "now" at 18:00:00 LOCAL today — deterministic, TZ-correct day
// ---------------------------------------------------------------------------
const realNow = new RealDate();
const FIXED_NOW = new RealDate(
  realNow.getFullYear(), realNow.getMonth(), realNow.getDate(), 18, 0, 0, 0
);
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW.getTime());
    else super(...args);
  }
  static now() { return FIXED_NOW.getTime(); }
}
global.Date = FixedDate;

const Y = FIXED_NOW.getFullYear();
const M = FIXED_NOW.getMonth();
const D = FIXED_NOW.getDate();
const yest = new RealDate(Y, M, D - 1);      // handles month/year boundaries
const YY = yest.getFullYear();
const YM = yest.getMonth();
const YD = yest.getDate();
const NOW_SEC = Math.floor(FIXED_NOW.getTime() / 1000);
const startOfDaySec = Math.floor(new RealDate(Y, M, D, 0, 0, 0).getTime() / 1000);

/** Local-time (y,mo,d,h,mi,s) -> unix seconds. */
const T = (y, mo, d, h, mi, s) => Math.floor(new RealDate(y, mo, d, h, mi, s).getTime() / 1000);

// ---------------------------------------------------------------------------
// 3. Seed helpers
// ---------------------------------------------------------------------------
function clearAll() {
  db.exec('DELETE FROM grid_status');
  db.exec('DELETE FROM history');
  db.exec('DELETE FROM latest_metrics');
  db.exec("DELETE FROM config WHERE key = 'grid_status_entity'");
  db.exec("DELETE FROM config WHERE key = 'ha_devices'");
}
const addState = (sec, state) =>
  db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(sec, state);
const setEntity = (v) => setConfig('grid_status_entity', v);
const setLatestText = (metric, text) =>
  db.prepare(`INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp, unit, value_text, value_type)
              VALUES (?, NULL, ?, '', ?, 'text')`).run(metric, NOW_SEC, text);
const hrs = (h) => `${h.toFixed(4)}h`;

// ---------------------------------------------------------------------------
// 4. Assertion runner
// ---------------------------------------------------------------------------
let failures = 0;
const lines = [];
function check(name, ok, detail) {
  if (!ok) failures++;
  const line = `[${ok ? 'PASS' : 'FAIL'}] ${name}: ${detail}`;
  lines.push(line);
  console.log(line);
}

// ---------------------------------------------------------------------------
// 5. The 9 assertions (AC1..AC10 per issue-#64 context)
// ---------------------------------------------------------------------------
(async () => {
  console.log('== Epilykos issue #64 — grid-hours regression test ==');
  console.log(`temp DB : ${path.join(tmpDir, 'data', 'energy.db')} (fresh via initializeDatabase, cwd-injected)`);
  console.log(`frozen  : local now = ${new RealDate(FIXED_NOW.getTime()).toString()}\n`);

  // --- [1/9] AC1 text-state recording -------------------------------------
  clearAll();
  setEntity('Grid Status');
  setLatestText('Grid Status', 'on');        // value stays NULL, value_text='on'
  {
    const s = await grid.getCurrentGridStatus();
    check('AC1 text-state recording',
      s.configured === true && s.available === true && s.current === true,
      `latest_metrics value=NULL value_text='on' -> getCurrentGridStatus() = ` +
      `{configured:${s.configured}, available:${s.available}, current:${s.current}} (readLatestGridState -> 1)`);
  }

  // --- [2/9] AC3 numeric hours math ---------------------------------------
  clearAll();
  setEntity('sensor.grid');
  addState(T(Y, M, D, 0, 10, 0), 1);         // ON 00:10
  addState(T(Y, M, D, 1, 10, 0), 0);         // OFF 01:10
  {
    const h = await grid.getGridHours('day');
    check('AC3 numeric hours math',
      Math.abs(h - 1.0) <= 1 / 3600,
      `ON 00:10 -> OFF 01:10 => ${hrs(h)} (expected 1.0000h)`);
  }

  // --- [3/9] AC4 midnight rollover ----------------------------------------
  // (a) ON 23:59:30 yesterday -> OFF 00:00:10 today: the 40s event straddles
  //     midnight; only the post-midnight 10s belongs to today. The guard is
  //     that the pre-midnight ON is NOT lost (result > 0, not 0).
  clearAll();
  setEntity('sensor.grid');
  addState(T(YY, YM, YD, 23, 59, 30), 1);    // ON yesterday 23:59:30
  addState(T(Y, M, D, 0, 0, 10), 0);         // OFF today 00:00:10
  const hA = await grid.getGridHours('day');
  const okA = hA > 0 && Math.abs(hA - 10 / 3600) <= 1 / 3600;
  // (b) ON 23:50 yesterday, still ON now -> today = time since 00:00
  clearAll();
  setEntity('sensor.grid');
  addState(T(YY, YM, YD, 23, 50, 0), 1);     // ON yesterday 23:50, no OFF
  const hB = await grid.getGridHours('day');
  const expectedB = (NOW_SEC - startOfDaySec) / 3600;   // DST-proof expectation
  const okB = Math.abs(hB - expectedB) <= 1 / 3600;
  check('AC4 midnight rollover',
    okA && okB,
    `(a) ON 23:59:30y -> OFF 00:00:10t => ${hrs(hA)} (10s in today; 40s event, 30s in yesterday) — rollover NOT lost; ` +
    `(b) ON 23:50y still ON => ${hrs(hB)} (expected ${hrs(expectedB)} = time since 00:00)`);

  // --- [4/9] AC5 00:01 supply ---------------------------------------------
  clearAll();
  setEntity('sensor.grid');
  addState(T(Y, M, D, 0, 1, 0), 1);          // ON 00:01
  addState(T(Y, M, D, 0, 45, 0), 0);         // OFF 00:45
  {
    const h = await grid.getGridHours('day');
    check('AC5 00:01 supply',
      Math.abs(h - 44 / 60) <= 1 / 3600,
      `ON 00:01 -> OFF 00:45 => ${hrs(h)} (expected ${hrs(44 / 60)} = 44 min)`);
  }

  // --- [5/9] AC6 2-minute event precision (D3 regression guard) ------------
  clearAll();
  setEntity('sensor.grid');
  addState(T(Y, M, D, 14, 0, 0), 1);         // ON 14:00
  addState(T(Y, M, D, 14, 2, 0), 0);         // OFF 14:02
  {
    const h = await grid.getGridHours('day');
    check('AC6 2-min precision (D3 guard)',
      h >= 0.03 && Math.abs(h - 120 / 3600) <= 1 / 3600,
      `ON 14:00 -> OFF 14:02 => ${hrs(h)} (expected ${hrs(120 / 3600)} = 2 min; NOT 0.0)`);
  }

  // --- [6/9] AC7 multiple short events -------------------------------------
  clearAll();
  setEntity('sensor.grid');
  addState(T(Y, M, D, 7, 2, 0), 1);          // ON 07:02
  addState(T(Y, M, D, 7, 4, 0), 0);          // OFF 07:04
  addState(T(Y, M, D, 7, 5, 0), 1);          // ON 07:05
  addState(T(Y, M, D, 7, 9, 0), 0);          // OFF 07:09
  {
    const h = await grid.getGridHours('day');
    check('AC7 multiple short events',
      Math.abs(h - 360 / 3600) <= 1 / 3600,
      `07:02-07:04 + 07:05-07:09 => ${hrs(h)} (expected ${hrs(360 / 3600)} = 6 min)`);
  }

  // --- [7/9] AC8 zero day --------------------------------------------------
  clearAll();
  setEntity('sensor.grid');
  addState(T(YY, YM, YD, 23, 50, 0), 0);     // last row yesterday: OFF
  {
    const h = await grid.getGridHours('day');
    check('AC8 zero day',
      h === 0,
      `no rows today, last yesterday OFF => ${hrs(h)} (expected 0)`);
  }

  // --- [8/9] AC9 unconfigured ----------------------------------------------
  clearAll();
  setConfig('grid_status_entity', '');       // empty -> not configured
  {
    const s = await grid.getCurrentGridStatus();
    const h = await grid.getGridHours('day');
    check('AC9 unconfigured',
      h === 0 && s.configured === false && s.available === false,
      `grid_status_entity='' => getGridHours('day')=${hrs(h)}, getCurrentGridStatus()=` +
      `{configured:${s.configured}, available:${s.available}}`);
  }

  // --- [9/9] AC10 cross-pipeline -------------------------------------------
  clearAll();
  setEntity('Grid Status');
  addState(T(Y, M, D, 15, 0, 0), 1);         // ON 15:00
  addState(T(Y, M, D, 15, 10, 0), 0);        // OFF 15:10
  db.prepare('INSERT INTO history (timestamp, daily_grid_import, grid_import) VALUES (?, 1.6, 250)').run(NOW_SEC);
  {
    const h = await grid.getGridHours('day');
    const hist = db.prepare('SELECT daily_grid_import FROM history WHERE timestamp = ?').get(NOW_SEC);
    check('AC10 cross-pipeline',
      h > 0 && Math.abs(h - 600 / 3600) <= 1 / 3600,
      `history daily_grid_import=${hist && hist.daily_grid_import} seeded + ON 15:00 -> 15:10 => ${hrs(h)} (> 0)`);
  }

  // --- summary -------------------------------------------------------------
  const passed = lines.length - failures;
  console.log(`\nSummary: ${passed}/${lines.length} assertions passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
})().catch((err) => {
  console.error('FATAL: test runner crashed:', err);
  process.exitCode = 1;
});
