'use strict';
const checks = require('./_checks');
// Energy chart "Compare": each year side by side (Jan to Dec), or this month
// against last month day by day; plus the card markup and the monthly API.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

(async () => {
  const { compareYears, compareMonths, compareMonthDays, compareTotals, shade } = await import(pathToFileURL(path.join(__dirname, '../public/js/charts.js')).href);
  const now = new Date(2026, 9, 21, 15);          // Wednesday 21 October 2026

  // Year on year.
  const rows = [];
  for (const [y, from, to, base] of [[2023, 1, 12, 5], [2024, 1, 12, 6], [2025, 3, 12, 7], [2026, 1, 10, 8]]) {
    for (let m = from; m <= to; m++) rows.push({ month: `${y}-${String(m).padStart(2, '0')}`, solar_kwh: base * m, consumption_kwh: 1 });
  }
  const years = compareYears(rows, 'solar_kwh', 4, now);
  assert.deepEqual(years.series.map(s => s.name), ['2023', '2024', '2025', '2026']);
  assert.equal(years.labels.length, 12);
  assert.equal(years.titles.length, 12);
  assert.deepEqual(years.series[2].values.slice(0, 4), [null, null, 21, 28], 'a month with no record is a gap, not zero');
  assert.deepEqual(years.series[3].values.slice(8), [72, 80, null, null], 'months not reached yet are gaps');
  assert.equal(years.series[1].total, 6 * 78);
  assert.deepEqual(years.series.map(s => s.partial), [false, false, false, true], 'only this year is "so far"');
  const three = compareYears(rows, 'solar_kwh', 3, now);
  assert.deepEqual(three.series.map(s => s.name), ['2024', '2025', '2026'], 'the newest years, oldest first');
  assert.deepEqual(compareYears([], 'solar_kwh', 4, now).series, []);
  assert.equal(compareYears(rows, 'consumption_kwh', 4, now).series[0].total, 12);
  console.log('ok - year on year: one series per year, Jan to Dec, gaps where nothing was recorded');

  // Month on month.
  const dayStr = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daily = [];
  for (let i = 0; i < compareMonthDays(now); i++) {
    const d = new Date(2026, 8, 1 + i);
    daily.push({ day: dayStr(d.getFullYear(), d.getMonth() + 1, d.getDate()), solar_kwh: d.getMonth() === 8 ? 10 : 20 });
  }
  assert.equal(compareMonthDays(now), 30 + 21, '1 Sep to 21 Oct');
  assert.equal(compareMonthDays(new Date(2026, 2, 1)), 28 + 1, 'last month from its 1st, this month just today');
  const months = compareMonths(daily, 'solar_kwh', now);
  assert.equal(months.series.length, 2);
  assert.match(months.series[0].name, /September/);
  assert.match(months.series[1].name, /October/);
  assert.equal(months.labels.length, 31, 'as many days as the longer of the two months');
  assert.equal(months.series[0].values.length, 31);
  assert.equal(months.series[0].values[29], 10);
  assert.equal(months.series[0].values[30], null, 'September has no 31st');
  assert.equal(months.series[0].total, 300);
  assert.equal(months.series[1].values[20], 20);
  assert.equal(months.series[1].values[21], null, 'days after today are gaps');
  assert.equal(months.series[1].total, 21 * 20);
  assert.deepEqual(months.series.map(s => s.partial), [false, true]);
  assert.equal(months.titles[4], 'Day 5');
  const jan = compareMonths([], 'solar_kwh', new Date(2026, 0, 10));
  assert.match(jan.series[0].name, /December/, 'January compares with the December before it');
  console.log('ok - month on month: last month and this month day by day, no values for days that have not happened');

  // Yearly totals: every year on record, whole.
  const long = [];
  for (let y = 2020; y <= 2026; y++) {
    const from = y === 2020 ? 3 : 1, to = y === 2026 ? 10 : 12;
    for (let m = from; m <= to; m++) long.push({ month: `${y}-${String(m).padStart(2, '0')}`, solar_kwh: 100, consumption_kwh: 50.555, grid_import_kwh: 0 });
  }
  const totals = compareTotals(long, ['solar_kwh', 'consumption_kwh'], now);
  assert.deepEqual(totals.labels, ['2020', '2021', '2022', '2023', '2024', '2025', '2026'], 'every year, oldest first, not just the newest four');
  assert.deepEqual(totals.series.map(s => s.field), ['solar_kwh', 'consumption_kwh']);
  assert.deepEqual(totals.series[0].values, [1000, 1200, 1200, 1200, 1200, 1200, 1000], 'each year added up');
  assert.equal(totals.series[1].values[1], 606.66, '12 x 50.555, rounded to 2 places');
  assert.match(totals.titles[0], /^2020 · .+ to .+$/, 'a year recording began part-way says from when');
  assert.equal(totals.titles[1], '2021');
  assert.equal(totals.titles[6], '2026 · so far');
  assert.deepEqual(compareTotals([], ['solar_kwh'], now), { labels: [], titles: [], series: [{ field: 'solar_kwh', values: [] }] });
  assert.deepEqual(compareTotals([{ month: 'bad', solar_kwh: 5 }, { month: '2025-13', solar_kwh: 5 }], ['solar_kwh'], now).labels, [], 'rows that are not a month are ignored');
  console.log('ok - yearly totals: every year on record whole, with the partial years named');

  assert.equal(shade('#f59e0b', 0.5), 'rgba(245,158,11,0.5)');
  assert.equal(shade('#fb0', 1), 'rgba(255,187,0,1)');
  assert.equal(shade('rgb(10, 20, 30)', 0.35), 'rgba(10,20,30,0.35)');
  assert.equal(shade('', 0.5), '#888');
  console.log('ok - older years are the same colour, lighter');

  // The card and the data it asks for.
  const card = read('public/js/components/chartEnergy.js');
  assert.match(card, /<button data-range="1y">1y<\/button><button data-range="compare">Compare<\/button>/);
  assert.match(card, /<option value="year">Year on year<\/option><option value="month">Month on month<\/option>/);
  assert.match(card, /<option value="month">Month on month<\/option><option value="total">Yearly totals<\/option>/);
  assert.match(card, /chart-compare-metric/);
  assert.doesNotMatch(card, /type="radio"/);
  const server = read('routes/metrics.js');
  assert.match(server, /req\.query\.all === '1'/);
  const css = read('public/style.css');
  assert.match(css, /\.chart-compare\[hidden\]/);
  console.log('ok - the card has Compare, a Year on year / Month on month choice and a metric choice; /api/monthly?all=1 exists');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
