'use strict';
const checks = require('./_checks');
/**
 * The Bluetooth helper's D-Bus connection to the host can close under it after hours of running.
 * Every request then fails at once (EOFError, "Bad file descriptor") instead of timing out, so the
 * helper was never restarted and Bluetooth stayed down until the machine was rebooted.
 * - the helper reports that as code 'dbus_lost' (ble_helper.py --self-test covers the mapping);
 * - the app replaces the helper process, at most once a minute, and the next request works again;
 * - lost again within 15 minutes of a restart: the log says to restart Bluetooth on the host.
 */
const assert = require('node:assert/strict');
const path = require('path');
const REPO = path.join(__dirname, '..');
const { BleHelper } = require(path.join(REPO, 'modules/ble'));
const { logger } = require(path.join(REPO, 'modules/logger'));
const FAKE = path.join(__dirname, 'fixtures', 'fake-ble-helper.js');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const warnings = [];
  const realWarn = logger.warn.bind(logger);
  logger.warn = (...a) => { warnings.push(a.join(' ')); };
  const h = new BleHelper({ command: process.execPath, args: [FAKE], isConfigured: () => true, linkCount: () => 1 });
  try {
    const pid1 = (await h.request('echo')).pid;

    // Lost: the helper is replaced; the poll after the short restart pause works.
    await h.request('fail', { code: 'dbus_lost' }).then(() => assert.fail('should reject'), e => assert.equal(e.code, 'dbus_lost'));
    await wait(1300);
    const pid2 = (await h.request('echo')).pid;
    assert.notEqual(pid2, pid1, 'a new helper process, with a new D-Bus connection');
    assert.ok(warnings.some(w => /stopping helper: it lost its D-Bus connection/.test(w)));
    assert.ok(!warnings.some(w => /restart Bluetooth on the host/.test(w)), 'the first time says nothing about the host');
    console.log('ok - a lost D-Bus connection replaces the helper process');

    // Again at once: no restart loop.
    await h.request('fail', { code: 'dbus_lost' }).catch(() => {});
    await wait(200);
    assert.equal((await h.request('echo')).pid, pid2, 'at most one restart a minute');
    console.log('ok - at most one restart a minute');

    // Lost again a few minutes after a restart: the host is at fault, and the log says so.
    h.lastDbusRestart = Date.now() - 3 * 60 * 1000;
    await h.request('fail', { code: 'dbus_lost' }).catch(() => {});
    await wait(1300);
    const pid3 = (await h.request('echo')).pid;
    assert.notEqual(pid3, pid2);
    assert.ok(warnings.some(w => /lost again right after restarting the helper: restart Bluetooth on the host \(sudo systemctl restart bluetooth\)/.test(w)));
    console.log('ok - lost again soon after a restart: the log points at the host');

    // Other errors do not restart anything.
    await h.request('fail', { code: 'timeout' }).catch(() => {});
    await h.request('fail', { code: 'ble_error' }).catch(() => {});
    assert.equal((await h.request('echo')).pid, pid3);
    console.log('ok - other errors leave the helper alone');
  } finally {
    logger.warn = realWarn;
    await h.stop();
  }
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
