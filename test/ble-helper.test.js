'use strict';
/**
 * test/ble-helper.test.js — modules/ble.js process supervisor, driven against
 * a fake helper (test/fixtures/fake-ble-helper.js). No Bluetooth or D-Bus needed.
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'ble-helper-')));
const { BleHelper, isValidAddress, isConfigured } = require(path.join(REPO, 'modules/ble'));

const FAKE = path.join(__dirname, 'fixtures', 'fake-ble-helper.js');
const make = (env) => {
  if (env) Object.assign(process.env, env);
  return new BleHelper({ command: process.execPath, args: [FAKE], isConfigured: () => true });
};

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log('ok - ' + name);
}

(async () => {
  try {
    await ok('address validation', async () => {
      assert.ok(isValidAddress('AA:BB:CC:DD:EE:FF'));
      assert.ok(isValidAddress('aa:bb:cc:dd:ee:0f'));
      assert.ok(!isValidAddress('AA:BB:CC:DD:EE'));
      assert.ok(!isValidAddress('192.168.1.10'));
      assert.ok(!isValidAddress(undefined));
    });

    await ok('BLUETOOTH=off disables Bluetooth', async () => {
      process.env.BLUETOOTH = 'off';
      assert.strictEqual(isConfigured(), false);
      delete process.env.BLUETOOTH;
    });

    await ok('no D-Bus socket -> fails fast without spawning', async () => {
      const h = new BleHelper({ command: process.execPath, args: [FAKE], isConfigured: () => false });
      await assert.rejects(h.request('echo', {}), e => e.code === 'no_dbus');
      assert.strictEqual(h.child, null);
    });

    await ok('request/response round trip, one process reused', async () => {
      const h = make();
      const a = await h.request('echo', { n: 1 });
      const b = await h.request('echo', { n: 2 });
      assert.strictEqual(a.n, 1);
      assert.strictEqual(b.n, 2);
      assert.strictEqual(a.pid, b.pid);
      await h.stop();
    });

    await ok('requests are serialised in order', async () => {
      const h = make();
      const slow = h.request('echo', { n: 1, delayMs: 150 });
      const fast = h.request('echo', { n: 2 });
      const [r1, r2] = await Promise.all([slow, fast]);
      assert.ok(r2.at >= r1.at, 'second request answered before the first finished');
      await h.stop();
    });

    await ok('helper errors carry their code', async () => {
      const h = make();
      await assert.rejects(h.request('fail', { code: 'not_found' }), e => e.code === 'not_found' && e.message === 'nope');
      // the helper stays usable after an error reply
      assert.strictEqual((await h.request('echo', { n: 3 })).n, 3);
      await h.stop();
    });

    await ok('timeout kills the helper and backs off before restarting', async () => {
      const h = make();
      const first = (await h.request('echo', {})).pid;
      await assert.rejects(h.request('hang', {}, 200), e => e.code === 'timeout');
      await new Promise(r => setTimeout(r, 300)); // let the killed process exit
      await assert.rejects(h.request('echo', {}), e => e.code === 'restarting');
      h.notBefore = 0; // skip the backoff
      const second = (await h.request('echo', {})).pid;
      assert.notStrictEqual(first, second);
      await h.stop();
    });

    await ok('helper crash rejects pending requests', async () => {
      const h = make();
      await h.request('echo', {});
      await assert.rejects(h.request('die', {}), e => e.code === 'helper_exit');
      h.notBefore = 0;
      assert.ok(await h.request('echo', {}));
      await h.stop();
    });

    await ok('idle helper exits and restarts on demand without backoff', async () => {
      const h = new BleHelper({ command: process.execPath, args: [FAKE], isConfigured: () => true, idleExitMs: 100 });
      const first = (await h.request('echo', {})).pid;
      await new Promise(r => setTimeout(r, 400));
      assert.strictEqual(h.child, null, 'helper still running after idle period');
      const second = (await h.request('echo', {})).pid; // no 'restarting' error
      assert.notStrictEqual(first, second);
      await h.stop();
    });

    await ok('missing executable is reported, not thrown', async () => {
      const h = new BleHelper({ command: '/nonexistent/python3', args: [], isConfigured: () => true });
      await assert.rejects(h.request('echo', {}), e => e.code === 'start_failed');
      assert.strictEqual(h.child, null);
    });

    console.log(`# ${passed} passed`);
    process.exit(0);
  } catch (err) {
    console.error('not ok -', err);
    process.exit(1);
  }
})();
