'use strict';
const checks = require('./_checks');
// Savings: a finished day keeps the value it had when it was counted, so changing the prices or the method
// re-values today and the days to come, not the past, and All time never drops because of a setting.
// "Recalculate history" counts every finished day again at the current settings.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-savings-frozen-')));
const { initializeDatabase, getDb, setConfig, getConfig } = require(path.join(REPO, 'modules/database'));
initializeDatabase();
const db = getDb();
const { computeSavings, recalculateSavingsHistory } = require(path.join(REPO, 'modules/solarValue'));
const { isProtectedKey } = require(path.join(REPO, 'modules/protectedConfig'));

const at = (d, h, m = 0) => Math.floor(new Date(2026, 2, d, h, m).getTime() / 1000);
const ins = db.prepare('INSERT INTO history(timestamp, solar, daily_solar) VALUES (?, ?, ?)');
const day = (d, total) => { ins.run(at(d, 8), 1000, total / 2); ins.run(at(d, 12), 1000, total); ins.run(at(d, 18), 0, total); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
const run = (d, h, m = 0, todayKwh = 0) => computeSavings({ todaySolarKwh: todayKwh, db, now: new Date(2026, 2, d, h, m) });

setConfig('savings_rate', '100');
setConfig('savings_method', 'grid');
for (let d = 1; d <= 5; d++) day(d, 10);              // 1 to 5 March: 10 kWh each

// First run: every finished day is counted at the settings of the day.
let s = run(10, 12);
near(s.all, 5000, 'all time at 100 a kWh');
assert.equal(db.prepare('SELECT COUNT(*) n FROM savings_daily').get().n, 5, 'five days kept');
assert.equal(getConfig('savings_frozen_through'), '2026-03-10', 'counted up to the day before today');
console.log('ok - the first run counts the finished days');

// A price change reaches today, not the past.
setConfig('savings_rate', '200');
s = run(10, 13, 0, 4);                                // 4 kWh so far today
near(s.today, 800, 'today at the new price');
near(s.all, 5000 + 800, 'all time: the five days at 100, today at 200');
near(s.year, 5800, 'year');
console.log('ok - a new price changes today and leaves the past alone');

// Lowering a price or switching the method never lowers what finished days are worth.
setConfig('savings_rate', '50'); setConfig('savings_method', 'bought');
s = run(10, 14, 0, 4);
near(s.all, 5000 + 4 * 50, 'all time after a lower price and another method');
setConfig('savings_method', 'availability');
near(run(10, 15, 0, 4).all, 5000 + 4 * 50, 'and another method again');
console.log('ok - a lower price or another method does not lower the past');

// Later days are counted at the prices in force when they finish.
setConfig('savings_rate', '200'); setConfig('savings_method', 'grid');
day(10, 7);                                           // 7 kWh on the 10th
s = run(11, 12);                                      // the 10th is over (and past the grace hours)
near(s.all, 5000 + 7 * 200, 'the 10th at 200');
setConfig('savings_rate', '1000');
near(run(11, 13).all, 5000 + 7 * 200, 'a later change leaves the 10th at 200');
assert.equal(getConfig('savings_frozen_through'), '2026-03-11');
console.log('ok - each day is kept at the price of the day it was counted');

// The first hours after midnight: yesterday is not kept yet, so it follows the settings until then.
setConfig('savings_rate', '200');
day(11, 5);
near(run(12, 1, 0).all, 5000 + 1400 + 5 * 200, 'at 01:00 the 11th is worked out at 200');
setConfig('savings_rate', '300');
near(run(12, 2, 0).all, 5000 + 1400 + 5 * 300, 'at 02:00 it follows the change to 300');
near(run(12, 4, 0).all, 5000 + 1400 + 5 * 300, 'at 04:00 it is counted at 300');
setConfig('savings_rate', '400');
near(run(12, 5, 0).all, 5000 + 1400 + 1500, 'and stays at 300 after another change');
console.log('ok - a day is counted a few hours after midnight, not at midnight');

// Recalculate history re-values every finished day at the current settings.
recalculateSavingsHistory(db);
assert.equal(db.prepare('SELECT COUNT(*) n FROM savings_daily').get().n, 0);
s = run(12, 6);
near(s.all, (5 * 10 + 7 + 5) * 400, 'every finished day at 400');
assert.equal(db.prepare('SELECT COUNT(*) n FROM savings_daily').get().n, 7);
console.log('ok - recalculate re-values the whole history');

// A database that cannot keep the days still gives the right figures, worked out each time.
db.exec('DROP TABLE savings_daily');
s = run(12, 7);
near(s.all, (5 * 10 + 7 + 5) * 400, 'without the table');
db.exec('CREATE TABLE savings_daily (day TEXT PRIMARY KEY, kwh REAL NOT NULL, price REAL NOT NULL, value REAL NOT NULL, method TEXT NOT NULL)');
console.log('ok - figures do not depend on the table being there');

// The marker is the server's, not Settings'.
assert.ok(isProtectedKey('savings_frozen_through'));
assert.ok(!isProtectedKey('savings_rate'));
console.log('ok - only the server moves how far days are counted');
checks.done();
