'use strict';
const checks = require('./_checks');
/**
 * The power chart's statistics (mean, min, max, last) cover today since local
 * midnight, so they start again at midnight; they used to cover a rolling 24 h,
 * which after midnight still held yesterday's readings. The energy chart now
 * opens on 30d.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const charts = await import(pathToFileURL(path.join(__dirname, '../public/js/charts.js')).href);
  const { powerStatsWindow } = charts;
  const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s);
  const secs = date => Math.floor(date.getTime() / 1000);

  const morning = at(2026, 9, 28, 10, 30);
  let w = powerStatsWindow('24h', morning);
  assert.equal(w.from, secs(at(2026, 9, 28)), 'from local midnight today');
  assert.equal(w.to, secs(morning));
  assert.ok(w.from > secs(morning) - 24 * 3600, 'yesterday morning is not in it');
  console.log('ok - at 10:30 the statistics start at midnight, not 24 hours ago');

  const lateNight = at(2026, 9, 28, 23, 59, 30);
  w = powerStatsWindow('24h', lateNight);
  assert.equal(w.from, secs(at(2026, 9, 28)));
  const after = at(2026, 9, 29, 0, 20);
  w = powerStatsWindow('24h', after);
  assert.equal(w.from, secs(at(2026, 9, 29)), 'twenty minutes into the next day: only that day');
  console.log('ok - the window moves to the new day at midnight');

  w = powerStatsWindow('24h', at(2026, 9, 29, 0, 0, 20));
  assert.ok(w.from < w.to, 'the server needs from < to');
  assert.equal(w.to - w.from, 60, 'a minute of history in the first seconds of the day');
  console.log('ok - the first seconds after midnight still make a valid request');

  w = powerStatsWindow('3d', morning);
  assert.equal(w.to - w.from, 72 * 3600, 'the 3d view is still the last 72 hours');
  console.log('ok - the 3d view stays the last 72 hours');

  const src = fs.readFileSync(path.join(__dirname, '../public/js/charts.js'), 'utf8');
  assert.match(src, /const statsKey = `\$\{range\}\|\$\{statsWindow\.from\}\|/, "a cached answer from yesterday is never reused");
  assert.match(src, /power-stats\?from=\$\{statsWindow\.from\}&to=\$\{statsWindow\.to\}/);
  console.log('ok - the request and its cache use the new window');

  assert.match(src, /DEFAULT_RANGE = \{ power: '24h', energy: '30d', metric: '24h' \}/);
  const card = fs.readFileSync(path.join(__dirname, '../public/js/components/chartEnergy.js'), 'utf8');
  assert.match(card, /<button data-range="7d">7d<\/button><button data-range="30d" class="active">30d<\/button>/);
  assert.doesNotMatch(card, /data-range="7d" class="active"/);
  console.log('ok - the energy chart card opens on 30d');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
