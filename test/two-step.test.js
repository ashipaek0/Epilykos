'use strict';
/**
 * test/two-step.test.js — the two-step sign-in module (modules/twoStep.js):
 * RFC 4226/6238 codes, one use per code, recovery codes, the file's contents
 * and permissions, and the failure paths (lost encryption key, damaged file).
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-step-'));
process.env.TWO_STEP_FILE = path.join(dir, 'two-step.json');
process.env.ENC_KEY_FILE = path.join(dir, 'encryption-key');
const twoStep = require('../modules/twoStep');

// RFC 4226 appendix D: secret "12345678901234567890", counters 0..2.
const rfcKey = Buffer.from('12345678901234567890');
assert.equal(twoStep.hotp(rfcKey, 0), '755224');
assert.equal(twoStep.hotp(rfcKey, 1), '287082');
assert.equal(twoStep.hotp(rfcKey, 2), '359152');
// RFC 6238: T = 59 s is step 1, so the 6-digit code is 287082.
const rfcSecret = twoStep.base32Encode(rfcKey);
assert.equal(twoStep.codeAt(rfcSecret, 59 * 1000), '287082');
assert.deepEqual(twoStep.base32Decode(rfcSecret), rfcKey);
console.log('ok - codes match the RFC test vectors; base32 round-trips');

const secret = twoStep.generateSecret();
assert.match(secret, /^[A-Z2-7]{32}$/);
const uri = twoStep.otpauthUri(secret, { account: 'box.local' });
assert.ok(uri.startsWith('otpauth://totp/Epilykos:box.local?secret=' + secret));
assert.match(uri, /digits=6&period=30/);
console.log('ok - a 160-bit secret and an otpauth address for the app');

const t0 = Date.UTC(2026, 9, 27, 12, 0, 10);
assert.equal(twoStep.isEnabled(), false);
assert.deepEqual(twoStep.status(), { enabled: false, recoveryLeft: 0, broken: false });
assert.equal(twoStep.enable(secret, '000000', { now: t0 }), null, 'a wrong code does not turn it on');
assert.equal(twoStep.isEnabled(), false);
const codes = twoStep.enable(secret, twoStep.codeAt(secret, t0), { now: t0 });
assert.equal(codes.length, 10);
assert.ok(codes.every(c => /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/.test(c)));
assert.equal(new Set(codes).size, 10);
assert.equal(twoStep.isEnabled(), true);
assert.equal(twoStep.status().recoveryLeft, 10);
console.log('ok - enabling needs a valid code and returns ten distinct recovery codes');

const file = process.env.TWO_STEP_FILE;
const raw = fs.readFileSync(file, 'utf8');
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
assert.ok(!raw.includes(secret), 'the secret is not stored in the clear');
for (const c of codes) assert.ok(!raw.includes(c) && !raw.includes(c.replace('-', '')), 'recovery codes are stored hashed');
assert.match(JSON.parse(raw).secret, /^\$enc1\$/);
console.log('ok - the file is private, the secret is encrypted, recovery codes are hashed');

// The code used to enable cannot sign in again; the next one can.
assert.deepEqual(twoStep.check(twoStep.codeAt(secret, t0), { now: t0 }), { ok: false, reason: 'wrong' });
const t1 = t0 + 30000;
assert.deepEqual(twoStep.check(twoStep.codeAt(secret, t1), { now: t1 }), { ok: true, kind: 'totp' });
assert.deepEqual(twoStep.check(twoStep.codeAt(secret, t1), { now: t1 }), { ok: false, reason: 'wrong' }, 'a code works once');
console.log('ok - a code is accepted once, so a seen code cannot be replayed');

// A minute of drift either way is tolerated; two minutes is not.
const t2 = t1 + 60000;
assert.equal(twoStep.check(twoStep.codeAt(secret, t2 - 30000), { now: t2 }).ok, true, 'one step behind');
const t3 = t2 + 90000;
assert.equal(twoStep.check(twoStep.codeAt(secret, t3 + 30000), { now: t3 }).ok, true, 'one step ahead');
const t4 = t3 + 600000;
assert.equal(twoStep.check(twoStep.codeAt(secret, t4 - 120000), { now: t4 }).ok, false, 'two steps behind');
assert.equal(twoStep.check('12345', { now: t4 }).ok, false);
assert.equal(twoStep.check('abcdef', { now: t4 }).ok, false);
assert.equal(twoStep.check('', { now: t4 }).ok, false);
assert.equal(twoStep.check(null, { now: t4 }).ok, false);
console.log('ok - about a minute of clock drift is tolerated, no more; junk is refused');

const first = codes[0];
assert.deepEqual(twoStep.check(first.toLowerCase().replace('-', ' ')), { ok: true, kind: 'recovery', recoveryLeft: 9 });
assert.equal(twoStep.check(first).ok, false, 'a recovery code works once');
assert.equal(twoStep.check('AAAAA-AAAAA').ok, false);
assert.equal(twoStep.status().recoveryLeft, 9);
console.log('ok - a recovery code works once, however it is typed');

const fresh = twoStep.regenerateRecovery();
assert.equal(fresh.length, 10);
assert.equal(twoStep.status().recoveryLeft, 10);
assert.equal(twoStep.check(codes[1]).ok, false, 'old recovery codes stop working');
assert.equal(twoStep.check(fresh[0]).ok, true);
console.log('ok - new recovery codes replace the old ones');

// Lost encryption key: the app's code cannot be checked, recovery codes still work, nothing opens.
fs.unlinkSync(process.env.ENC_KEY_FILE);
fs.writeFileSync(process.env.ENC_KEY_FILE, Buffer.alloc(32, 7), { mode: 0o600 });
assert.deepEqual(twoStep.check(twoStep.codeAt(secret, t4), { now: t4 }), { ok: false, reason: 'secret-unreadable' });
assert.equal(twoStep.check(fresh[1]).ok, true);
console.log('ok - without the encryption key the app code is refused and a recovery code still works');

// A damaged file fails closed.
fs.writeFileSync(file, '{not json');
assert.deepEqual(twoStep.status(), { enabled: true, recoveryLeft: 0, broken: true });
assert.deepEqual(twoStep.check('123456'), { ok: false, reason: 'broken' });
assert.equal(twoStep.regenerateRecovery(), null);
console.log('ok - a damaged file means "on and unusable", never "off"');

// Turning it off, and the Docker reset.
twoStep.disable();
assert.equal(twoStep.isEnabled(), false);
twoStep.disable();
const again = twoStep.enable(secret, twoStep.codeAt(secret, t4), { now: t4 });
assert.equal(again.length, 10);
process.env.RESET_TWO_STEP = 'false';
assert.equal(twoStep.applyEnvReset(), false);
assert.equal(twoStep.isEnabled(), true);
process.env.RESET_TWO_STEP = 'true';
assert.equal(twoStep.applyEnvReset(), true);
assert.equal(twoStep.isEnabled(), false);
assert.equal(twoStep.applyEnvReset(), false);
console.log('ok - disable removes the file; RESET_TWO_STEP=true removes it at start');

fs.rmSync(dir, { recursive: true, force: true });
checks.done();
