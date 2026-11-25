'use strict';
const checks = require('./_checks');
/**
 * Anonymous history is thinned (modules/metrics.js thinSeries, used by GET /api/metrics/history without a sign-in): a series longer
 * than 2,016 points (a week at the stored 5-minute resolution) is averaged into time buckets, a shorter one is untouched, and a
 * signed-in request is never thinned. The dashboard's cards need no more, and an anonymous request should not cost a raw week of a
 * fast metric.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-anon-history-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const { initializeDatabase, getDb } = require('../modules/database');
initializeDatabase();
const { getMetricHistory, thinSeries } = require('../modules/metrics');

// ── thinSeries (pure) ───────────────────────────────────────────────────
const series = n => Array.from({ length: n }, (_, i) => ({ timestamp: 1_000_000_000_000 + i * 30_000, value: i % 100 }));
const small = series(100);
assert.strictEqual(thinSeries(small, 2016, 7 * 86400e3), small, 'a series within the limit comes back as it is');
assert.strictEqual(thinSeries(small, 0, 1000), small, 'no limit, no change');
assert.deepStrictEqual(thinSeries([], 5, 1000), []);
assert.strictEqual(thinSeries(null, 5, 1000), null);

const big = series(20160);                                   // a week at 30 s
const thin = thinSeries(big, 2016, 7 * 86400e3);
assert.ok(thin.length <= 2016 + 1, `thinned to the limit (${thin.length})`);   // one extra bucket at most, where the window edge cuts a bucket
assert.ok(thin.length > 1900, 'and not thinned more than it has to be');
for (let i = 1; i < thin.length; i++) assert.ok(thin[i].timestamp > thin[i - 1].timestamp, 'oldest first, one point per bucket');
assert.ok(thin.every(p => p.timestamp % 300_000 === 0), 'buckets are the stored 5-minute size for a week');
const mean = a => a.reduce((s, p) => s + p.value, 0) / a.length;
assert.ok(Math.abs(mean(big) - mean(thin)) < 1.5, 'the average of the series is kept');
assert.ok(thin[thin.length - 1].timestamp <= big[big.length - 1].timestamp && thin[thin.length - 1].timestamp > big[big.length - 1].timestamp - 300_000, 'the newest bucket holds the newest readings');
const withBad = thinSeries([{ timestamp: 0, value: NaN }, { timestamp: 1, value: 4 }, { timestamp: 5000, value: 6 }], 1, 10_000);
assert.ok(withBad.every(p => Number.isFinite(p.value)), 'a non-number reading is skipped, not averaged in');
console.log('ok - thinSeries: short series untouched, long ones averaged to 5-minute buckets for a week');

// ── Through the database ────────────────────────────────────────────────
const db = getDb();
const now = Math.floor(Date.now() / 1000);
const ins = db.prepare('INSERT INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
db.transaction(() => { for (let i = 0; i < 20160; i++) ins.run(now - i * 30, 'fast_metric', i % 100); })();
db.transaction(() => { for (let i = 0; i < 100; i++) ins.run(now - i * 30, 'slow_metric', i); })();
const full = getMetricHistory('fast_metric', 168);
assert.ok(full.length > 5000, `signed in: every stored point (${full.length})`);
const capped = getMetricHistory('fast_metric', 168, { maxPoints: 2016 });
assert.ok(capped.length <= 2017 && capped.length > 1000, `anonymous: thinned (${capped.length})`);
assert.ok(Math.abs(mean(full) - mean(capped)) < 2, 'with the same average');
assert.strictEqual(getMetricHistory('slow_metric', 168, { maxPoints: 2016 }).length, 100, 'a short series is not touched');
assert.throws(() => getMetricHistory('', 24, { maxPoints: 2016 }), /Metric name required/);
console.log('ok - from the database: signed-in gets every point, anonymous gets the thinned series');

// ── The route ───────────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(src, /const PUBLIC_HISTORY_MAX_POINTS = 2016;/);
assert.match(src, /getMetricHistory\(metric, hours, signedIn \? \{\} : \{ maxPoints: PUBLIC_HISTORY_MAX_POINTS \}\)/, 'only an anonymous request is thinned');
console.log('ok - the history route thins only anonymous requests');
checks.done();
