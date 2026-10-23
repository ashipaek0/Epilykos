'use strict';
const checks = require('./_checks');
// Energy chart: 6m shows 26 weekly totals (weeks from Monday), 1y shows 12
// monthly totals; 7d/30d/90d stay daily.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

(async () => {
  const { energyRangeDays, groupEnergy } = await import(pathToFileURL(path.join(__dirname, '../public/js/charts.js')).href);
  const wed = new Date(2026, 9, 21, 15);            // Wednesday 21 October 2026
  assert.equal(energyRangeDays('7d', wed), 7);
  assert.equal(energyRangeDays('90d', wed), 90);
  assert.equal(energyRangeDays('6m', wed), 25 * 7 + 3, '25 whole weeks and this one from Monday 19 Oct');
  assert.equal(energyRangeDays('6m', new Date(2026, 9, 19)), 176, 'on a Monday, this week is one day');
  assert.equal(energyRangeDays('1y', wed), 355, '1 Nov 2025 to 21 Oct 2026');
  assert.equal(energyRangeDays('1y', new Date(2028, 9, 31)), 366, 'a year with 29 February in it');
  assert.ok(energyRangeDays('1y', new Date(2028, 9, 31)) <= 366, 'within what /api/daily serves');
  console.log('ok - each range asks for the days it needs');

  const day = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(2026, 8, 25 + i);              // Fri 25 Sep .. Sun 4 Oct
    rows.push({ day: day(d.getFullYear(), d.getMonth() + 1, d.getDate()), solar_kwh: 10, consumption_kwh: 8, grid_import_kwh: i === 3 ? null : 1 });
  }
  assert.equal(groupEnergy(rows, undefined), rows, 'daily ranges are left as they are');
  const weeks = groupEnergy(rows, 'week');
  assert.deepEqual(weeks.map(w => w.day), ['2026-09-21', '2026-09-28'], 'weeks start on Monday');
  assert.deepEqual(weeks.map(w => [w.solar_kwh, w.consumption_kwh, w.grid_import_kwh]), [[30, 24, 3], [70, 56, 6]], 'summed; a missing value counts as 0');
  assert.ok(weeks.every(w => w.by === 'week'));
  const months = groupEnergy(rows, 'month');
  assert.deepEqual(months.map(m => [m.day, m.solar_kwh]), [['2026-09-01', 60], ['2026-10-01', 40]]);
  console.log('ok - daily totals summed into weeks from Monday, or months');

  assert.match(fs.readFileSync(path.join(__dirname, '../public/js/components/chartEnergy.js'), 'utf8'), /data-range="6m">6m<\/button><button data-range="1y">1y<\/button>/);
  assert.match(fs.readFileSync(path.join(__dirname, '../routes/metrics.js'), 'utf8'), /Math\.min\(requestedDays, 366\)/);
  console.log('ok - the card offers 6m and 1y; the API serves up to 366 days');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
