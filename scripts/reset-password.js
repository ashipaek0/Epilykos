#!/usr/bin/env node
'use strict';
/*
 * Reset the Epilykos admin password from the machine itself (no sign-in needed).
 * Needs file access to the data folder, which is the same trust as editing the files by hand.
 *
 *   node scripts/reset-password.js [--data-dir DIR] [--keep-two-step] [--stdin] [--service-xml FILE]
 *
 * Writes data/settings-password in the format modules/sessionAuth.js reads (salt:scrypt hash) and,
 * unless --keep-two-step is given, removes data/two-step.json (someone locked out has usually lost
 * the authenticator too). Restarting the service is left to the caller.
 * Exit codes: 0 done, 1 refused or failed.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_LENGTH = 12;

function parseArgs(argv) {
  const o = { dataDir: null, keepTwoStep: false, stdin: false, serviceXml: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-two-step') o.keepTwoStep = true;
    else if (a === '--stdin') o.stdin = true;
    else if (a === '--data-dir') o.dataDir = argv[++i];
    else if (a === '--service-xml') o.serviceXml = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** Pure part: returns an error string, or null when the password is acceptable. */
function checkPassword(pw, confirm) {
  if (typeof pw !== 'string' || pw.length < MIN_LENGTH) return `The password must be at least ${MIN_LENGTH} characters (remote access refuses a shorter one).`;
  if (confirm !== undefined && pw !== confirm) return 'The two passwords do not match.';
  return null;
}

/** True when the service (or this shell) sets SETTINGS_PASSWORD, which overrides the file. */
function passwordIsEnvManaged(env, serviceXml) {
  if (env.SETTINGS_PASSWORD) return 'SETTINGS_PASSWORD is set in this environment';
  if (serviceXml && fs.existsSync(serviceXml)) {
    if (/name\s*=\s*["']SETTINGS_PASSWORD["']/i.test(fs.readFileSync(serviceXml, 'utf8'))) return `SETTINGS_PASSWORD is set in ${serviceXml}`;
  }
  return null;
}

function writePasswordFile(dataDir, password) {
  fs.mkdirSync(dataDir, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const target = path.join(dataDir, 'settings-password');
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${salt}:${hashPassword(password, salt)}`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

function removeTwoStep(dataDir) {
  const f = path.join(dataDir, 'two-step.json');
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

/** Hidden prompt on a terminal; plain line read when input is piped. */
function ask(question, hidden) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!hidden || !stdin.isTTY) {
      let buf = '';
      const onData = (d) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) { stdin.off('data', onData); stdin.pause(); resolve(buf.slice(0, nl).replace(/\r$/, '')); }
      };
      stdin.on('data', onData);
      stdin.on('end', () => reject(new Error('No input')));
      stdin.resume();
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onKey = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); return resolve(value); }
        if (c === '\u0003') { done(); return reject(new Error('Cancelled')); }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    const done = () => { stdin.setRawMode(false); stdin.off('data', onKey); stdin.pause(); process.stdout.write('\n'); };
    stdin.on('data', onKey);
  });
}

async function main(argv) {
  const opts = parseArgs(argv);
  const dataDir = path.resolve(opts.dataDir || process.env.EPILYKOS_DATA_DIR || path.join(__dirname, '..', 'data'));

  const managed = passwordIsEnvManaged(process.env, opts.serviceXml);
  if (managed) {
    console.error(`${managed}, so it overrides the password file and a reset would have no effect.`);
    console.error('Remove that setting, restart the service, and run this again.');
    return 1;
  }

  let pw;
  if (opts.stdin) {
    pw = await ask('', false);
    const err = checkPassword(pw);
    if (err) { console.error(err); return 1; }
  } else {
    pw = await ask(`New admin password (${MIN_LENGTH} or more characters): `, true);
    const again = await ask('Type it again: ', true);
    const err = checkPassword(pw, again);
    if (err) { console.error(err); return 1; }
  }

  writePasswordFile(dataDir, pw);
  console.log(`Admin password changed (${dataDir}).`);
  if (!opts.keepTwoStep && removeTwoStep(dataDir)) console.log('Two-step sign-in was switched off. Turn it back on in Settings.');
  return 0;
}

module.exports = { parseArgs, checkPassword, passwordIsEnvManaged, writePasswordFile, removeTwoStep, hashPassword, MIN_LENGTH };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
