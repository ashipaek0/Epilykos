'use strict';
const checks = require('./_checks');
// Grid card extras: grid hours per local day (bars), "all time" hours, and
// what the grid energy bought cost per period.
process.env.TZ = 'Africa/Lagos';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-gridcard-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');

const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const grid = require('../modules/grid');
const { computeGridCost } = require('../routes/metrics');
const { localDateString } = require('../modules/localTime');

const H = 3600;
const now = new Date();
const nowS = Math.floor(now.getTime() / 1000);
const midnight = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
const dayAgo = n => Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime() / 1000);
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.02, `${what}: ${a} vs ${b}`);

(async () => {
  // No grid history at all: every day is "no data", all time is 0.
  let days = grid.getGridDailyHours(30);
  assert.equal(days.length, 30);
  assert.ok(days.every(d => d.hours === null), 'nothing recorded yet');
  assert.equal(await grid.getGridHours('all'), 0);

  // Tracking began 3 days ago at 06:00 (on until 18:00); on from 2 days ago
  // at midnight until noon yesterday; on again from today's midnight.
  const ins = db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)');
  ins.run(dayAgo(3) + 6 * H, 1); ins.run(dayAgo(3) + 18 * H, 0);
  ins.run(dayAgo(2), 1); ins.run(dayAgo(1) + 12 * H, 0);
  ins.run(midnight, 1);

  days = grid.getGridDailyHours(30);
  const today = (nowS - midnight) / H;
  assert.deepEqual(days.slice(0, 26).map(d => d.hours), new Array(26).fill(null), 'days before tracking began have no data, not 0 h');
  near(days[26].hours, 12, '3 days ago: on from when tracking began, 06:00-18:00');
  near(days[27].hours, 24, '2 days ago: on all day');
  near(days[28].hours, 12, 'yesterday: on until noon');
  near(days[29].hours, today, 'today so far');
  assert.ok(days[29].today && !days[28].today);
  assert.equal(days[29].day, localDateString(now));
  assert.equal(days[0].day, localDateString(new Date(dayAgo(29) * 1000)));
  near(await grid.getGridHours('all'), 12 + 24 + 12 + today, 'all time');
  assert.equal(grid.getGridDailyHours(7).length, 7);
  console.log('ok - grid hours per day: no data before tracking, days split at local midnight, today so far; all-time hours');

  // Costs: unavailable without a daily grid import metric, rather than 0.
  assert.deepEqual(computeGridCost(db), { available: false });
  database.setConfig('role_metrics', JSON.stringify({ daily_grid_import: 'grid_import_today' }));
  database.setConfig('savings_rate', '100');
  database.setConfig('savings_currency', '₦');
  const hist = db.prepare('INSERT OR REPLACE INTO history (timestamp, daily_grid_import) VALUES (?, ?)');
  const seeded = [[400, 7], [1, 10], [0, 3]];  // days ago, kWh
  for (const [n, kwh] of seeded) hist.run(n === 0 ? Math.max(midnight + 1, nowS - 60) : dayAgo(n) + 23 * H, kwh);

  const c = computeGridCost(db);
  const dow = now.getDay();
  const weekStart = dayAgo(dow === 0 ? 6 : dow - 1);
  const expect = { day: 0, week: 0, month: 0, year: 0, all: 0 };
  for (const [n, kwh] of seeded) {
    const t = new Date(dayAgo(n) * 1000);
    expect.all += kwh;
    if (t.getFullYear() === now.getFullYear()) expect.year += kwh;
    if (t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth()) expect.month += kwh;
    if (dayAgo(n) >= weekStart) expect.week += kwh;
    if (n === 0) expect.day += kwh;
  }
  assert.equal(c.available, true);
  assert.equal(c.currency, '₦');
  assert.equal(c.price, 100);
  assert.deepEqual(c.kwh, expect);
  assert.deepEqual(c.cost, Object.fromEntries(Object.entries(expect).map(([k, v]) => [k, v * 100])));
  console.log('ok - grid cost: daily grid import × buy price per period; unavailable without a grid import metric');

  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
