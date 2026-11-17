'use strict';
// Tailscale on Windows (system mode): Epilykos drives the Tailscale client already on the PC. It never starts its own
// tailscaled, never passes --socket, never renames or logs out a machine that is already signed in, and "off" only
// removes what Epilykos serves.
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-ts-sys-')));
process.env.TAILSCALE_SYSTEM = '1';
const tailscale = require('../modules/tailscale');

let backend = 'Running';
const calls = [];
tailscale.setRunnerForTests({
  execFile(bin, args, opts, cb) {
    calls.push(['exec', ...args].join(' '));
    setImmediate(() => {
      if (args[0] === 'version') return cb(null, '1.102.5\n', '');
      if (args[0] === 'status') return cb(null, JSON.stringify({ BackendState: backend, Self: { DNSName: 'pc.tail1.ts.net.', Online: true }, TailscaleIPs: ['100.64.0.2'] }), '');
      if (args[0] === 'serve' && args[1] === 'status') return cb(null, '{}', '');
      if (args[0] === 'serve' && args[1] === 'reset') return cb(null, '', '');
      cb(new Error('unexpected ' + args.join(' ')), '', 'unexpected');
    });
  },
  spawn(bin, args) {
    calls.push(['spawn', path.basename(bin), ...args].join(' '));
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', '{"AuthURL":"https://login.tailscale.com/a/xyz"}\n'); });
    return c;
  }
});

(async () => {
  // Already signed in: connect does not run `up`, so the PC's Tailscale name and login are left alone.
  let st = await tailscale.connect({ name: 'Epilykos' });
  assert.equal(st.state, 'running');
  assert.ok(!calls.some(c => c.startsWith('spawn tailscale up') || c.includes('tailscaled')), calls.join('\n'));
  assert.ok(!calls.some(c => c.includes('--socket')), 'no --socket in system mode');

  // Off: serve is reset; there is no logout and nothing is stopped.
  calls.length = 0;
  await tailscale.disconnect();
  assert.ok(calls.includes('exec serve reset'), calls.join('\n'));
  assert.ok(!calls.some(c => c.includes('logout')), 'never logs the PC out of its tailnet');

  // Not signed in: `up` runs and a sign-in link comes back.
  backend = 'NeedsLogin'; calls.length = 0;
  await tailscale.connect({ name: 'Epilykos' });
  assert.ok(calls.some(c => c.startsWith('spawn tailscale up --json --hostname=epilykos')), calls.join('\n'));

  // Signed in earlier but stopped: its existing name is kept (no --hostname).
  backend = 'Stopped'; calls.length = 0;
  await tailscale.connect({ name: 'Epilykos' });
  assert.ok(calls.some(c => c === 'spawn tailscale up --json'), calls.join('\n'));
  await tailscale.disconnect();
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
