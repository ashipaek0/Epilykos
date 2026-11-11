'use strict';
const checks = require('./_checks');
/**
 * An external source that fails is not asked again every poll, and not logged every poll.
 * Seen on a real install: Open-Meteo answered HTTP 429 (daily limit) to a poll every 30 s from
 * 22:00 to 08:00, which kept it limited and filled the log buffer with one line, hiding the rest.
 * - a 429 waits 15 min, then 30, 60, 120; a Retry-After is believed (1 min to 6 h);
 * - any other failure waits 1, 2, 4 ... polls, up to 15 min;
 * - the first failure is logged with the service's own reason, then at most once an hour;
 * - an answer again is logged once and ends the waiting; saving the settings tries at once.
 */
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-external-backoff-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
database.setConfig('external_poll_interval', '30');
database.setConfig('external_sources', JSON.stringify([{ enabled: true, name: 'OpenMeteo Weather', url: 'http://weather.example', mappings: { ambient_temperature: 'current.temperature_2m' } }]));
global.setInterval = () => 1; global.clearInterval = () => {};   // no real timers
const utils = require('../modules/utils');
utils.assertSafeFetchUrl = async url => ({ ok: true, url });
let answer = null; const asked = [];
utils.safeFetch = async url => { asked.push(Date.now()); return answer(); };
const { logger } = require('../modules/logger');
const lines = { error: [], info: [], debug: [] };
for (const level of Object.keys(lines)) logger[level] = (...a) => lines[level].push(a.join(' '));
const external = require('../modules/external');

let clock = 1_800_000_000_000;
Date.now = () => clock;
const tick = ms => { clock += ms; };
const limited = (headers = {}) => () => ({ ok: false, status: 429, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => '{"error":true,"reason":"Daily API request limit exceeded. Please try again tomorrow."}' });
const ok = () => ({ ok: true, status: 200, json: async () => ({ current: { temperature_2m: 31.5 } }) });
const poll = () => external.pollExternalSources();

(async () => {
  // The delays.
  const { retryDelayMs } = external, M = 60000, H = 60 * M;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => retryDelayMs({ status: 429 }, n, 30000)), [15 * M, 30 * M, 60 * M, 2 * H, 2 * H, 2 * H]);
  assert.equal(retryDelayMs({ status: 429, retryAfter: 120 }, 1, 30000), 2 * M, 'a Retry-After is believed');
  assert.equal(retryDelayMs({ status: 429, retryAfter: 5 }, 1, 30000), M, 'but not below a minute');
  assert.equal(retryDelayMs({ status: 429, retryAfter: 10 ** 7 }, 1, 30000), 6 * H, 'or above six hours');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => retryDelayMs({ status: 500 }, n, 30000) / 1000), [30, 60, 120, 240, 480, 900, 900, 900, 900, 900]);
  console.log('ok - the delays grow, and stay within limits');

  // A 429 night: one request, one log line with the reason, then quiet.
  answer = limited();
  await poll();
  assert.equal(asked.length, 1);
  assert.equal(lines.error.length, 1);
  assert.match(lines.error[0], /OpenMeteo Weather error: HTTP 429: Daily API request limit exceeded/);
  assert.match(lines.error[0], /trying again in 15 min/);
  for (let i = 0; i < 20; i++) { tick(30000); await poll(); }   // ten minutes of polls
  assert.equal(asked.length, 1, 'no request while it rests');
  assert.equal(lines.error.length, 1, 'and no more log lines');
  tick(6 * M); await poll();                                    // past 15 min
  assert.equal(asked.length, 2);
  assert.equal(lines.error.length, 1, 'the same failure again is not logged again');
  assert.match(lines.debug[lines.debug.length - 1], /2 polls failed in a row\); trying again in 30 min/);
  console.log('ok - a rate limit is asked again later and later, and logged once');

  // An hour on: a reminder.
  for (let i = 0; i < 4; i++) { tick(2 * H); await poll(); }
  assert.ok(lines.error.length >= 2 && /polls failed in a row/.test(lines.error[1]), 'a reminder after an hour');
  assert.equal(lines.error.length, 5, 'one an hour or less often, not one a poll');
  console.log('ok - a reminder at most once an hour');

  // It answers again: said once, and polled normally from then on.
  answer = ok; tick(2 * H); await poll();
  assert.equal(lines.info.filter(l => /is answering again after \d+ failed polls/.test(l)).length, 1);
  const before = asked.length;
  tick(30000); await poll(); tick(30000); await poll();
  assert.equal(asked.length, before + 2, 'every poll again');
  console.log('ok - an answer ends the waiting');

  // Retry-After, and a plain failure.
  answer = limited({ 'retry-after': '120' }); tick(30000); await poll();
  assert.match(lines.error[lines.error.length - 1] + lines.debug[lines.debug.length - 1], /trying again in 2 min/);
  const n = asked.length; tick(60000); await poll(); assert.equal(asked.length, n, 'rests for the Retry-After');
  tick(61000); answer = ok; await poll(); assert.equal(asked.length, n + 1);
  answer = () => ({ ok: false, status: 500, text: async () => '' });
  tick(30000); await poll();                 // first failure
  tick(30000); await poll();                 // retried at the next poll: second failure
  assert.equal(asked.length, n + 3);
  tick(30000); await poll();                 // now it rests for two polls
  assert.equal(asked.length, n + 3, 'the second failure waits two polls');
  tick(30000); await poll();
  assert.equal(asked.length, n + 4);
  console.log('ok - Retry-After is believed; other failures back off by polls');

  // Saving the settings tries a resting source again at once.
  answer = limited(); tick(10 * M); await poll();
  const m = asked.length; tick(30000); await poll(); assert.equal(asked.length, m, 'resting');
  answer = ok; external.startExternalPolling(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.ok(asked.length > m, 'restarting the polling asks again at once');
  external.stopExternalPolling();
  console.log('ok - saving the settings tries again at once');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
