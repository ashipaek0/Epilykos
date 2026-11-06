'use strict';
const checks = require('./_checks');
// Daily peaks and histograms of solar power (modules/peaks.js, GET /api/peaks, GET /api/histogram).
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-peaks-')));
const { initializeDatabase, getDb } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const peaks = require(path.join(REPO, 'modules/peaks'));
const { runHistoryBatch } = require(path.join(REPO, 'modules/retentionJob'));
const { localDateString } = require(path.join(REPO, 'modules/localTime'));

const now = new Date();
const dayAt = (back, h, m = 0) => Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h, m).getTime() / 1000);
const ins = db.prepare('INSERT INTO history(timestamp, solar, daily_solar) VALUES (?, ?, 0)');
// Each day: a morning ramp, a midday peak, an evening tail. Peak = 3000 + back * 100 W (so the days differ).
function day(back) { const peak = 3000 + back * 100; for (const [h, f] of [[7, 0.1], [10, 0.6], [12, 1], [15, 0.5], [18, 0.05]]) ins.run(dayAt(back, h), Math.round(peak * f), ); return peak; }
const expected = {};
for (const back of [1, 2, 3, 5, 40, 41, 100]) expected[localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12))] = day(back);

const dayKeys = Object.keys(expected);
function allPeaks() { const { from, fromDay } = peaks.windowOf(400, now); return peaks.dailySolarPeaks(db, from, Math.floor(now.getTime() / 1000) + 1, fromDay); }

// The highest reading of each day, across the whole history.
let found = allPeaks();
for (const d of dayKeys) assert.equal(found.get(d), expected[d], `peak of ${d}`);
assert.equal(found.size, dayKeys.length, 'only days with readings');
console.log('ok - daily solar peaks from the stored readings');

// After the old raw readings are rolled up into 5-minute summaries the peaks are the same.
const cutoff = Math.floor(now.getTime() / 1000) - 30 * 86400;
while (runHistoryBatch(db, cutoff)) { /* one window at a time */ }
assert.equal(db.prepare('SELECT COUNT(*) n FROM history WHERE timestamp < ?').get(cutoff).n, 0, 'old raw rows are gone');
found = allPeaks();
for (const d of dayKeys) assert.equal(found.get(d), expected[d], `peak of ${d} after the rollup`);
console.log('ok - the same peaks once old days are rolled up');

// A series has every day of the window, with null where there is no reading.
const series = peaks.peaksSeries(found, 7, now);
assert.equal(series.length, 7);
assert.equal(series[6].day, localDateString(now), 'today last');
assert.equal(series[6].value, null, 'today has no readings yet: a gap');
assert.equal(series[5].value, expected[localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12))], 'yesterday');
assert.equal(series[2].value, null, 'a day with no readings is a gap');   // 4 days back
assert.equal(peaks.median([3, 1, 2]), 2); assert.equal(peaks.median([1, 2, 3, 4]), 2.5); assert.equal(peaks.median([]), null);
console.log('ok - a series with gaps, and the median');

// A metric's highest per day, from readings and from 5-minute summaries.
const m = db.prepare('INSERT INTO metrics(timestamp, metric, value) VALUES (?, ?, ?)');
m.run(dayAt(1, 9), 'pv_peak_today', 1200); m.run(dayAt(1, 13), 'pv_peak_today', 3900); m.run(dayAt(1, 20), 'pv_peak_today', 3900);
m.run(dayAt(1, 13), 'other', 99999);
db.prepare('INSERT INTO metrics_5m (bucket_start, metric, value_avg, value_min, value_max, value_count) VALUES (?, ?, ?, ?, ?, ?)').run(Math.floor(dayAt(60, 12) / 300) * 300, 'pv_peak_today', 3000, 2000, 4400, 5);
const mp = peaks.dailyMetricPeaks(db, 'pv_peak_today', dayAt(70, 0), Math.floor(now.getTime() / 1000) + 1, localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 70, 12)));
assert.equal(mp.get(localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12))), 3900, 'the metric’s own highest, not another metric’s');
assert.equal(mp.get(localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60, 12))), 4400, 'from a 5-minute summary');
console.log('ok - a metric’s daily highest');

// Histogram bands: round edges, every value counted once, the last band holds its upper edge.
const h = peaks.histogram([2100, 2600, 3000, 3100, 3400, 4900, 5000], { bins: 5 });
assert.equal(h.step, 1000); assert.deepEqual(h.bins.map(b => [b.from, b.to, b.count]), [[2000, 3000, 2], [3000, 4000, 3], [4000, 5000, 2]]);
assert.equal(h.bins.reduce((a, b) => a + b.count, 0), 7);
const z = peaks.histogram([0, 100, 450, 900, 1800], { bins: 4, fromZero: true });
assert.deepEqual(z.bins.map(b => b.count), [3, 1, 0, 1]); assert.equal(z.bins[0].from, 0);
assert.deepEqual(peaks.histogram([], {}), { step: 0, bins: [], total: 0 });
assert.equal(peaks.histogram([5], { bins: 10 }).bins.length, 1, 'one value is one band');
assert.deepEqual(peaks.histogram([-3, NaN, 'x', 10], { bins: 4, fromZero: true }).total, 1, 'only real, non-negative values');
const w = peaks.histogram([100, 100, 900], { bins: 2, fromZero: true, weight: 5 / 60 });
assert.ok(Math.abs(w.total - 0.25) < 1e-9 && Math.abs(w.bins.reduce((a, b) => a + b.count, 0) - 0.25) < 1e-9, 'weighted counts add up (hours)');
assert.equal(peaks.niceStep(4, 10), 0.5); assert.equal(peaks.niceStep(2800, 10), 500); assert.equal(peaks.niceStep(0, 10), 1);
console.log('ok - histogram bands');

// Time at each power level: 5-minute averages, night left out.
const t = peaks.solarPowerSamples(db, dayAt(6, 0), Math.floor(now.getTime() / 1000) + 1, {});
assert.ok(t.length > 0 && t.every(v => v >= peaks.NIGHT_WATTS), 'night is left out');
assert.ok(peaks.solarPowerSamples(db, dayAt(6, 0), Math.floor(now.getTime() / 1000) + 1, { includeNight: true }).length >= t.length);
console.log('ok - samples for time at power');

// The routes.
const express = require('express');
const app = express();
app.use('/api', require(path.join(REPO, 'routes/metrics')).router);
const srv = app.listen(0, async () => {
  const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(e); } }); }).on('error', reject));
  try {
    let r = await get('/api/peaks?days=7');
    assert.equal(r.status, 200); assert.equal(r.body.days.length, 7); assert.equal(r.body.unit, 'W');
    assert.equal(r.body.highest.value, Math.max(...r.body.days.map(d => d.value || 0))); assert.equal(r.body.daysWithData, 4);
    r = await get('/api/peaks?days=366&source=metric&metric=pv_peak_today');
    assert.equal(r.status, 200); assert.equal(r.body.source, 'metric'); assert.equal(r.body.highest.value, 4400); assert.equal(r.body.unit, undefined);
    assert.equal((await get('/api/peaks?days=0')).status, 400);
    assert.equal((await get('/api/peaks?days=99999')).status, 400);
    assert.equal((await get('/api/peaks?days=7&source=metric')).status, 400, 'a metric source needs a metric');
    assert.equal((await get('/api/peaks?days=abc')).status, 400);
    r = await get('/api/histogram?days=366&mode=peaks&bins=5');
    assert.equal(r.status, 200); assert.equal(r.body.total, dayKeys.length); assert.ok(r.body.bins.length >= 2 && r.body.bins.every(b => b.to > b.from));
    r = await get('/api/histogram?days=30&mode=time&bins=8');
    assert.equal(r.status, 200); assert.equal(r.body.mode, 'time'); assert.equal(r.body.bins[0].from, 0); assert.ok(r.body.total > 0 && r.body.nightBelowWatts === 10);
    r = await get('/api/histogram?days=30&mode=time&night=1');
    assert.equal(r.body.nightBelowWatts, 0);
    assert.equal((await get('/api/histogram?days=0')).status, 400);
    console.log('ok - /api/peaks and /api/histogram');
    srv.close(); checks.done();
  } catch (e) { console.error(e); srv.close(); process.exit(1); }
});
