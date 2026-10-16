'use strict';

/**
 * A Tuya device that is not answering (off the Wi-Fi, unplugged, new IP):
 * tinytuya returns {"Error": ..., "Err": "905"} instead of raising, which the
 * bridge used to treat as "no readings" (poll) or "done" (switch), after ~50 s
 * of retries. Controls then kept showing the last reading as live, and a tap
 * timed out on the page and snapped back to that old state.
 *
 * Now: the bridge reports the error and gives up within seconds, the log says
 * once that the device stopped answering (and when it is back), and Tuya
 * controls show Unavailable once their reading is 3 minutes old.
 *
 * Run: node --test test/tuya-unreachable.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-tuya-unreachable-'));

// A stand-in tinytuya: the device's answers come from FAKE_TUYA, and each
// call records the retry settings it was given.
const fake = path.join(tmp, 'pylib', 'tinytuya');
fs.mkdirSync(fake, { recursive: true });
fs.writeFileSync(path.join(fake, '__init__.py'), `
import json, os
class Device:
    def __init__(self, *a): self.retries = None
    def set_version(self, v): pass
    def set_socketTimeout(self, t): pass
    def set_socketRetryLimit(self, n): self.retries = n
    def set_socketRetryDelay(self, d): pass
    def _log(self, what):
        with open(os.environ["FAKE_TUYA_LOG"], "a") as f: f.write(json.dumps([what, self.retries]) + "\\n")
    def status(self):
        self._log("status"); return json.loads(os.environ["FAKE_TUYA"])
    def set_value(self, dp, value):
        self._log("set"); return json.loads(os.environ["FAKE_TUYA"])
`);
const log = path.join(tmp, 'calls.log');
const bridge = (answer, ...args) => {
  fs.writeFileSync(log, '');
  const r = spawnSync('python3', [path.join(ROOT, 'modules', 'tuya_bridge.py'), ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.join(tmp, 'pylib'), FAKE_TUYA: JSON.stringify(answer), FAKE_TUYA_LOG: log },
  });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null, calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
};
const UNREACHABLE = { Error: 'Network Error: Device Unreachable', Err: '905', Payload: null };
const dev = ['bf1', '192.168.0.111', 'key', '3.3'];

test('bridge: an unreachable device is an error for poll, test and switch, not empty readings or "done"', () => {
  let r = bridge(UNREACHABLE, 'poll', ...dev);
  assert.equal(r.code, 1);
  assert.equal(r.out.error, 'Network Error: Device Unreachable (905)');
  r = bridge(UNREACHABLE, 'test', ...dev);
  assert.equal(r.out.success, false);
  assert.match(r.out.error, /Device Unreachable/);
  r = bridge(UNREACHABLE, 'set', ...dev, '1', 'false');
  assert.equal(r.code, 1);
  assert.equal(r.out.success, false, 'a switch that never reached the device is not reported as done');
  assert.match(r.out.error, /Device Unreachable/);
});

test('bridge: gives up within seconds (poll tries twice, a switch once), and good answers still work', () => {
  assert.deepEqual(bridge(UNREACHABLE, 'poll', ...dev).calls, [['status', 2]]);
  assert.deepEqual(bridge(UNREACHABLE, 'set', ...dev, '1', 'true').calls, [['set', 1]]);
  let r = bridge({ dps: { 1: false, 7: 0 } }, 'poll', ...dev);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { 1: false, 7: 0 });
  r = bridge({ dps: { 1: true } }, 'set', ...dev, '1', 'true');
  assert.equal(r.code, 0);
  assert.equal(r.out.success, true);
});

// ── The poller's log ──────────────────────────────────────────────────────
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const childProcess = require('node:child_process');
let answer = 'unreachable';
childProcess.execFile = (file, args, opts, cb) => {
  if (answer === 'unreachable') {
    const err = new Error('Command failed'); err.code = 1;
    return cb(err, JSON.stringify({ error: 'Network Error: Device Unreachable (905)' }), '');
  }
  cb(null, JSON.stringify({ 1: false }), '');
};
const { logger } = require('../modules/logger');
const tuya = require('../modules/tuya');

test('poller: says once that a device stopped answering, and when it is back', async () => {
  database.setConfig('tuya_devices', JSON.stringify([{ name: 'LR AC Switch', dev_id: 'bf1', address: '192.168.0.111', local_key: 'k', enabled: true, dps: { living_room_ac: '1' } }]));
  const seen = { warn: [], info: [], error: [] };
  const orig = { warn: logger.warn, info: logger.info, error: logger.error };
  for (const level of Object.keys(seen)) logger[level] = (m) => { seen[level].push(String(m)); };
  try {
    let r = await tuya.pollTuyaDevices();
    assert.equal(r.errors.length, 1, 'counted as a failed poll, not a success with 0 readings');
    await tuya.pollTuyaDevices();
    await tuya.pollTuyaDevices();
    assert.equal(seen.warn.filter(m => /is not answering/.test(m)).length, 1, 'one warning, not one every 30 s');
    assert.match(seen.warn[0], /"LR AC Switch" is not answering \(192\.168\.0\.111\): Network Error: Device Unreachable/);
    assert.equal(seen.error.length, 0);
    answer = 'ok';
    r = await tuya.pollTuyaDevices();
    assert.equal(r.errors.length, 0);
    assert.ok(seen.info.some(m => /"LR AC Switch" is answering again/.test(m)));
  } finally { Object.assign(logger, orig); }
});

// ── The controls ──────────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => src.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

test('controls: a Tuya reading over 3 minutes old shows Unavailable; HA and MQTT readings never go stale', () => {
  const box = {};
  vm.runInNewContext(`${strip(read('public/js/components/readingAge.js'))}\nglobalThis.api = { isStaleReading, STALE_AFTER_MS };`, box);
  const { isStaleReading } = box.api;
  const now = 1_800_000_000_000;
  assert.equal(isStaleReading('tuya', { value: 'true', timestamp: now - 60_000 }, now), false);
  assert.equal(isStaleReading('tuya', { value: 'true', timestamp: now - 4 * 60_000 }, now), true);
  assert.equal(isStaleReading('ha', { value: 'on', timestamp: now - 86_400_000 }, now), false, 'HA reports only changes');
  assert.equal(isStaleReading('mqtt', { value: 'ON', timestamp: now - 86_400_000 }, now), false);
  assert.equal(isStaleReading('tuya', { value: 'true' }, now), false, 'no timestamp, no guess');
});

test('controls: the button card paints an old Tuya "on" as Unavailable, not On', () => {
  const el = () => ({ textContent: '', classes: new Set(), classList: null, dataset: {}, attrs: {} });
  const stateEl = el();
  const card = {
    dataset: { metric: 'living_room_ac' }, _config: { source: 'tuya' }, disabled: false,
    classes: new Set(['button-card']),
    setAttribute(k, v) { this.attrs = { ...(this.attrs || {}), [k]: v }; },
    querySelector(sel) { return sel === '.bc-state' ? stateEl : null; },
  };
  card.classList = { contains: c => card.classes.has(c), toggle: (c, on) => (on ? card.classes.add(c) : card.classes.delete(c)), add: c => card.classes.add(c), remove: c => card.classes.delete(c) };
  const box = {
    escapeHtml: s => String(s), emptyBlock: () => null, mdiSvg: () => '',
    document: { querySelectorAll: () => [card] },
    Date,
  };
  vm.runInNewContext(`${strip(read('public/js/components/readingAge.js'))}\n${strip(read('public/js/components/buttonCard.js'))}\nglobalThis.update = updateButtonCardsFromState;`, box);
  box.update({ metrics: { living_room_ac: { value: 'true', timestamp: Date.now() - 10 * 60_000 } } });
  assert.equal(card.dataset.state, 'unknown');
  assert.equal(stateEl.textContent, 'Unavailable');
  box.update({ metrics: { living_room_ac: { value: 'false', timestamp: Date.now() } } });
  assert.equal(card.dataset.state, 'off', 'a fresh reading shows again');
  assert.equal(stateEl.textContent, 'Off');
  // The switch and mode controls use the same check.
  assert.match(read('public/js/components/switchBlock.js'), /isStaleReading\(checkbox && checkbox\.dataset\.source, data\)/);
  assert.match(read('public/js/components/stateSelectBlock.js'), /isStaleReading\(container\.dataset\.source, data\)/);
});
