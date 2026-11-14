'use strict';
// The LuxPower inverter clock (modules/luxpowerClock.js, the `inverter_time` and `inverter_clock_skew` entities in both
// LuxPowerTek profiles): decoding registers 12 to 14, the difference from the server's time across daylight saving, and
// that the two entities are mapped, polled and decoded without clashing with the raw RTC registers they share.
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'lux-clock-')));
process.env.ENC_KEY_FILE = path.join(process.cwd(), 'key');
require('../modules/database').initializeDatabase();
const { decodeInverterClock } = require('../modules/luxpowerClock');
const dongle = require('../modules/dongle');
const { dongleProfileEntities } = require('../modules/entityCatalog');

// Three registers, low byte first: year-2000 | month<<8, day | hour<<8, minute | second<<8
const words = (y, mo, d, h, mi, s) => [(y - 2000) | (mo << 8), d | (h << 8), mi | (s << 8)];

test('the clock is decoded and compared with the server\'s time', () => {
  const now = Date.UTC(2026, 10, 13, 11, 24, 0);
  assert.deepStrictEqual(decodeInverterClock(words(2026, 11, 13, 11, 24, 5), now), { text: '2026-11-13 11:24:05', skewSeconds: 5 }, 'ahead by 5 s');
  assert.strictEqual(decodeInverterClock(words(2026, 11, 13, 11, 22, 30), now).skewSeconds, -90, 'behind by 90 s');
  assert.strictEqual(decodeInverterClock(words(2026, 11, 13, 12, 24, 0), now).skewSeconds, 3600, 'an hour ahead: a clock that missed the change');
  assert.strictEqual(decodeInverterClock(words(2026, 11, 13, 11, 24, 0), now).skewSeconds, 0);
  assert.strictEqual(decodeInverterClock(words(2099, 12, 31, 23, 59, 59), now).text, '2099-12-31 23:59:59');
});

test('a reading that is not a date is not used', () => {
  const now = Date.UTC(2026, 10, 13, 11, 24, 0);
  for (const w of [words(2000, 0, 0, 0, 0, 0), words(2026, 13, 1, 0, 0, 0), words(2026, 2, 30, 0, 0, 0), words(2026, 11, 13, 24, 0, 0), words(2026, 11, 13, 11, 60, 0), words(2026, 11, 13, 11, 0, 60), [0, 0, 0]]) {
    assert.strictEqual(decodeInverterClock(w, now), null, JSON.stringify(w));
  }
  assert.strictEqual(decodeInverterClock([1, 2], now), null, 'two words are not enough'); assert.strictEqual(decodeInverterClock([undefined, 1, 2], now), null, 'a register that was not read'); assert.strictEqual(decodeInverterClock(null, now), null);
});

test('daylight saving: the repeated hour does not make a correct clock look an hour slow', () => {
  const run = (zone, w, nowIso) => require('child_process').execFileSync(process.execPath, ['-e', `process.env.TZ=${JSON.stringify(zone)}; const { decodeInverterClock } = require(${JSON.stringify(path.join(__dirname, '..', 'modules/luxpowerClock'))}); console.log(JSON.stringify(decodeInverterClock(${JSON.stringify(w)}, Date.parse(${JSON.stringify(nowIso)}))));`], { encoding: 'utf8', env: { ...process.env, TZ: zone } }).trim();
  // Berlin, 25 October 2026: at 03:00 CEST (01:00 UTC) the clocks go back to 02:00 CET, so 02:30 happens twice (00:30 UTC and 01:30 UTC).
  // It is 01:35 UTC (02:35 CET). An inverter showing 02:30 is 5 minutes behind, not 65.
  assert.strictEqual(JSON.parse(run('Europe/Berlin', words(2026, 10, 25, 2, 30, 0), '2026-10-25T01:35:00Z')).skewSeconds, -300, 'the nearer of the two 02:30s');
  // 00:35 UTC (02:35 CEST): the same reading is the first 02:30, 5 minutes behind.
  assert.strictEqual(JSON.parse(run('Europe/Berlin', words(2026, 10, 25, 2, 30, 0), '2026-10-25T00:35:00Z')).skewSeconds, -300);
  // An inverter that did not go back: it shows 03:35 when the server's clock reads 02:35 CET, an hour ahead.
  assert.strictEqual(JSON.parse(run('Europe/Berlin', words(2026, 10, 25, 3, 35, 0), '2026-10-25T01:35:00Z')).skewSeconds, 3600);
  // 29 March 2026: at 02:00 CET (01:00 UTC) the clocks go forward to 03:00 CEST. 02:30 does not exist; it is taken as the nearer reading.
  assert.strictEqual(JSON.parse(run('Europe/Berlin', words(2026, 3, 29, 2, 30, 0), '2026-03-29T01:10:00Z')).skewSeconds, 1200, 'the documented cost: that one hour looks correct');
  // A zone with no change at all
  assert.strictEqual(JSON.parse(run('Africa/Lagos', words(2026, 11, 13, 12, 0, 0), '2026-11-13T11:00:00Z')).skewSeconds, 0, 'Lagos is UTC+1');
});

for (const id of ['luxpower-geta', 'luxpower-geta-3k6-24v']) {
  const profile = require(`../profiles/dongles/${id}.json`);
  const byName = n => profile.metrics.find(m => m.name === n);
  const keyOf = m => `${m.register_type}:${m.register}${m.key_suffix || ''}`;

  test(`${id}: the clock and its skew are their own entities, beside the raw RTC registers`, () => {
    const time = byName('inverter_time'), skew = byName('inverter_clock_skew');
    assert.ok(time && skew && byName('rtc_year_month'), 'both new entities and the raw registers');
    assert.deepStrictEqual([time.register, time.count, skew.register, skew.count], ['0x000C', 3, '0x000C', 3]);
    assert.strictEqual(skew.unit, 's');
    const ids = dongleProfileEntities(profile).map(e => e.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'every entity id is unique, though they share registers');
    assert.ok(ids.includes('holding:0x000C#time') && ids.includes('holding:0x000C#skew') && ids.includes('holding:0x000C'));
  });

  test(`${id}: mapping the clock reads registers 12 to 14 and decodes it; the raw register is left alone`, () => {
    const time = byName('inverter_time'), skew = byName('inverter_clock_skew'), raw = byName('rtc_year_month');
    const inst = { name: 'T', prefix: '', mappings: { my_clock: keyOf(time), my_skew: keyOf(skew) } };
    const plan = dongle.luxpowerPollPlan(profile, inst);
    assert.deepStrictEqual([12, 13, 14].map(a => plan.words.holding.has(a)), [true, true, true], 'the three registers are read');
    assert.strictEqual(plan.words.input.size, 0, 'and nothing else');
    const now = Date.now(), d = new Date(now + 90 * 1000);   // an inverter 90 s ahead (the process zone is UTC)
    const reg = Object.fromEntries(words(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).map((w, i) => [`holding:${12 + i}`, w]));
    const out = dongle.decodeLuxpowerMetrics(profile, inst, reg);
    assert.match(out.metrics.my_clock, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/); assert.ok(Math.abs(out.metrics.my_skew - 90) <= 3, 'skew ' + out.metrics.my_skew);
    assert.strictEqual(out.units.my_skew, 's'); assert.deepStrictEqual(Object.keys(out.metrics).sort(), ['my_clock', 'my_skew']);
    // Only the raw register mapped: it is still a raw number, not the decoded clock
    const rawOut = dongle.decodeLuxpowerMetrics(profile, { name: 'T', prefix: '', mappings: { raw_ym: keyOf(raw) } }, reg);
    assert.deepStrictEqual(Object.keys(rawOut.metrics), ['raw_ym']); assert.strictEqual(rawOut.metrics.raw_ym, reg['holding:12']);
    // Registers not read yet, or an inverter that has not started up: nothing is emitted
    assert.deepStrictEqual(dongle.decodeLuxpowerMetrics(profile, inst, { 'holding:12': reg['holding:12'] }).metrics, {});
    assert.deepStrictEqual(dongle.decodeLuxpowerMetrics(profile, inst, { 'holding:12': 0, 'holding:13': 0, 'holding:14': 0 }).metrics, {});
  });
}
