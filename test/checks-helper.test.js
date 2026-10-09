'use strict';
const checks = require('./_checks');
// test/_checks.js and run-all.js: a fixture must report how many checks ran.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const helper = path.join(__dirname, '_checks.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-checks-'));
const run = (name, body) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `'use strict';\nconst checks = require(${JSON.stringify(helper)});\nconst assert = require('assert');\n${body}\n`);
  return spawnSync(process.execPath, [f], { encoding: 'utf8' });
};

// Counts every assert call, plain assert(...) included.
let r = run('ok.js', "assert(true); assert.strictEqual(1, 1); assert.match('a', /a/); checks.done();");
assert.strictEqual(r.status, 0); assert.match(r.stdout, /^# checks: 3$/m);

// A test that stops early exits 0 but never reports: run-all.js fails it.
r = run('stall.js', '(async () => { assert.ok(1); await new Promise(() => {}); checks.done(); })();');
assert.strictEqual(r.status, 0, 'Node itself exits 0');
assert.doesNotMatch(r.stdout, /# checks:/);
const runner = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
assert.match(runner, /did not report how many checks ran \(did it stop early\?\)/);

// No checks at all is a failure, a skip is reported as one.
r = run('none.js', 'checks.done();');
assert.strictEqual(r.status, 1); assert.match(r.stderr, /reported no checks/);
r = run('skip.js', "checks.skip('python3 not installed');");
assert.match(r.stdout, /^# checks: skipped \(python3 not installed\)$/m);

// Checks made without assert are added explicitly.
r = run('extra.js', 'checks.done(4);');
assert.match(r.stdout, /^# checks: 4$/m);

console.log('ok - checks helper counts, stalls and skips');
checks.done();
