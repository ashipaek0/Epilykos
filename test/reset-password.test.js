'use strict';
// The offline admin-password reset (scripts/reset-password.js): what it writes, what it removes, what it refuses.
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const rp = require('../scripts/reset-password');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'epi-reset-'));
const script = path.join(__dirname, '..', 'scripts', 'reset-password.js');
const run = (args, input, env) => spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', env: { ...process.env, SETTINGS_PASSWORD: '', ...env } });
const verify = (dir, pw) => {
  const [salt, hash] = fs.readFileSync(path.join(dir, 'settings-password'), 'utf8').trim().split(':');
  return rp.hashPassword(pw, salt) === hash;
};

// pure checks
assert.equal(rp.checkPassword('a-long-enough-pw'), null);
assert.match(rp.checkPassword('short'), /at least 12/);
assert.match(rp.checkPassword('a-long-enough-pw', 'different-one-xx'), /do not match/);
assert.throws(() => rp.parseArgs(['--nope']), /Unknown option/);
assert.deepEqual(rp.parseArgs(['--keep-two-step', '--stdin', '--data-dir', 'x']), { dataDir: 'x', keepTwoStep: true, stdin: true, serviceXml: null });

// the file is salt:hash, readable by the same formula sessionAuth uses, and replaces the old one
let d = tmp();
fs.writeFileSync(path.join(d, 'settings-password'), 'oldsalt:oldhash');
fs.writeFileSync(path.join(d, 'two-step.json'), '{}');
let r = run(['--stdin', '--data-dir', d], 'new password here\n');
assert.equal(r.status, 0, r.stderr);
assert.ok(verify(d, 'new password here'), 'new password verifies');
assert.ok(!verify(d, 'wrong password!!'), 'other passwords do not');
assert.ok(!fs.existsSync(path.join(d, 'two-step.json')), 'two-step removed by default');
assert.match(r.stdout, /Two-step sign-in was switched off/);
assert.deepEqual(fs.readdirSync(d).sort(), ['settings-password'], 'no temp file left behind');

// --keep-two-step leaves it alone
d = tmp(); fs.writeFileSync(path.join(d, 'two-step.json'), '{}');
r = run(['--stdin', '--keep-two-step', '--data-dir', d], 'new password here\n');
assert.equal(r.status, 0);
assert.ok(fs.existsSync(path.join(d, 'two-step.json')));

// a short password changes nothing
d = tmp(); fs.writeFileSync(path.join(d, 'settings-password'), 'oldsalt:oldhash');
r = run(['--stdin', '--data-dir', d], 'short\n');
assert.equal(r.status, 1);
assert.equal(fs.readFileSync(path.join(d, 'settings-password'), 'utf8'), 'oldsalt:oldhash');

// SETTINGS_PASSWORD in the environment or the service file overrides the file: refuse
d = tmp();
r = run(['--stdin', '--data-dir', d], 'new password here\n', { SETTINGS_PASSWORD: 'from-env-pass' });
assert.equal(r.status, 1); assert.match(r.stderr, /SETTINGS_PASSWORD/);
assert.ok(!fs.existsSync(path.join(d, 'settings-password')));
const xml = path.join(d, 'svc.xml');
fs.writeFileSync(xml, '<service><env name="SETTINGS_PASSWORD" value="x"/></service>');
r = run(['--stdin', '--data-dir', d, '--service-xml', xml], 'new password here\n');
assert.equal(r.status, 1); assert.match(r.stderr, /svc\.xml/);
fs.writeFileSync(xml, '<service><env name="PORT" value="3000"/></service>');
r = run(['--stdin', '--data-dir', d, '--service-xml', xml], 'new password here\n');
assert.equal(r.status, 0, r.stderr);

// the Windows wrapper and installer wiring exist
const win = path.join(__dirname, '..', 'packaging', 'windows');
assert.match(fs.readFileSync(path.join(win, 'epilykos-reset-password.cmd'), 'utf8'), /reset-password\.js/);
assert.match(fs.readFileSync(path.join(win, 'epilykos.iss'), 'utf8'), /Reset Epilykos admin password/);
assert.match(fs.readFileSync(path.join(win, 'stage.ps1'), 'utf8'), /epilykos-reset-password\.cmd/);

checks.done();
