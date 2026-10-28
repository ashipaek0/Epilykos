'use strict';
/**
 * test/docker-compose.test.js — docker-compose.yaml, and the copy of it in the
 * README, are valid Compose files as shipped and with every option turned on
 * the way the file tells people to (remove "# " from each line of a block).
 *
 * The README block must be the file, verbatim, so the two cannot drift. When
 * `docker compose` is installed (CI's runners have it; it needs no daemon for
 * `config`) the real parser checks each variant; without it only the static
 * checks run.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yaml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// ── Static: one source of truth, no characters YAML rejects ────────────────
const block = readme.match(/## Docker Compose\n\n```yaml\n([\s\S]*?)```\n/);
assert.ok(block, 'the README has a compose block');
assert.equal(block[1], compose, 'the README block is docker-compose.yaml, verbatim');
assert.ok(!/\t/.test(compose), 'no tabs (YAML forbids them)');
assert.ok(!/[ ]+$/m.test(compose), 'no trailing spaces');
assert.ok(!/\r/.test(compose), 'Unix line endings');
assert.match(compose, /^services:$/m, 'starts with a services: header');
assert.match(compose, /full control of Docker/, 'the socket line says what it grants');
console.log('ok - the README block is the compose file; no tabs, trailing spaces or CRs');

// Every option is a commented block that turns on by removing "# " after four spaces.
const OPTIONS = {
  devices: ['    # devices:', '    #   - "/dev/ttyUSB0:/dev/ttyUSB0"'],
  dialout: ['    # group_add:', '    #   - "dialout"'],
  bluetoothGroup: ['    # group_add:', '    #   - "108"'],
  timezone: ['    # environment:', '    #   - TZ=Europe/London'],
  host: ['    # network_mode: "host"']
};
const lineStart = line => compose.split('\n').some(l => l.startsWith(line));
for (const [name, lines] of Object.entries(OPTIONS)) for (const l of lines) assert.ok(lineStart(l), `${name}: "${l.trim()}" is in the file`);

function turnOn(names) {
  const wanted = new Set(names.flatMap(n => OPTIONS[n]));
  let seen = new Set();
  return compose.split('\n').map(l => {
    const hit = [...wanted].find(w => l.startsWith(w));
    if (!hit) return l;
    // A key shared by two options (group_add:) is turned on once.
    if (hit.endsWith(':') && seen.has(hit)) return l;
    seen.add(hit);
    return l.replace(/^(    )# /, '$1');
  }).join('\n');
}
const variants = {
  'as shipped': [],
  'serial adapter': ['devices', 'dialout'],
  'bluetooth group only': ['bluetoothGroup'],
  'serial and bluetooth groups': ['devices', 'dialout', 'bluetoothGroup'],
  'time zone': ['timezone'],
  'host networking': ['host'],
  'everything': ['devices', 'dialout', 'bluetoothGroup', 'timezone', 'host']
};
console.log('ok - each option is a block that turns on by removing "# "');

// ── With the real parser ───────────────────────────────────────────────────
const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('skipped - docker compose is not installed here; only the static checks ran');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
  const config = text => {
    const file = path.join(dir, 'docker-compose.yaml');
    fs.writeFileSync(file, text);
    const r = spawnSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], { encoding: 'utf8', cwd: dir });
    return { status: r.status, out: r.stdout, err: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
  };
  const svc = r => r.json.services.epilykos;

  for (const [name, on] of Object.entries(variants)) {
    const r = config(turnOn(on));
    assert.equal(r.status, 0, `${name}: ${r.err}`);
  }
  console.log('ok - docker compose accepts the file as shipped and with each option on');

  let s = svc(config(turnOn([])));
  assert.equal(s.image, 'irunmole/epilykos:latest');
  assert.deepEqual(s.ports.map(p => `${p.published}:${p.target}`), ['3000:3000']);
  assert.ok(s.volumes.some(v => v.target === '/app/data'));
  assert.ok(s.volumes.some(v => v.target === '/var/run/docker.sock'));
  assert.deepEqual(s.security_opt, ['apparmor=unconfined']);
  assert.equal(s.devices, undefined, 'no USB device is required by default');
  assert.equal(s.group_add, undefined);
  assert.equal(s.environment, undefined, 'the time zone follows the host unless one is chosen');
  assert.equal(s.network_mode, undefined);
  console.log('ok - shipped: the dashboard on 3000, data on ./data, no device or group needed to start');

  s = svc(config(turnOn(['devices', 'dialout'])));
  assert.deepEqual(s.devices.map(d => d.source), ['/dev/ttyUSB0']);
  assert.deepEqual(s.group_add, ['dialout']);
  s = svc(config(turnOn(['bluetoothGroup'])));
  assert.deepEqual(s.group_add, ['108']);
  s = svc(config(turnOn(['dialout', 'bluetoothGroup'])));
  assert.deepEqual(s.group_add, ['dialout', '108']);
  s = svc(config(turnOn(['timezone'])));
  assert.equal(s.environment.TZ, 'Europe/London');
  s = svc(config(turnOn(['host'])));
  assert.equal(s.network_mode, 'host');
  console.log('ok - each option does what its comment says');

  // The mistakes people make editing it are refused with a clear message, not silently accepted.
  const half = config(compose.replace('    # devices:', '    devices:'));
  assert.notEqual(half.status, 0, 'a key with no items is an error');
  assert.match(half.err, /devices/);
  const dup = config(turnOn(['dialout']) + '    group_add:\n      - "108"\n');
  assert.notEqual(dup.status, 0, 'a second group_add: is an error');
  console.log('ok - the usual editing mistakes fail loudly: a key with no items, a repeated key');
  fs.rmSync(dir, { recursive: true, force: true });
}

checks.done();
