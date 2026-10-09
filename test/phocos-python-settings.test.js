"use strict";
const checks = require("./_checks");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const result = spawnSync("python3", [path.join(root, "modules/ble/test_phocos_settings.py")], {
  cwd: root, encoding: "utf8", timeout: 30000,
});
const output = `${result.stdout || ""}${result.stderr || ""}`;
assert.equal(result.error, undefined, `Python fixture launch failed: ${result.error || ""}`);
assert.equal(result.status, 0, `Python settings fixture failed (exit ${result.status}):\n${output}`);
const match = output.match(/^Ran (\d+) tests? in /m);
assert.ok(match, `Python unittest completion summary missing:\n${output}`);
const count = Number(match[1]);
assert.ok(count > 0, `Python fixture ran zero tests:\n${output}`);
assert.match(output, /^OK\s*$/m, `Python unittest did not report success:\n${output}`);
console.log(`Python Phocos settings fixture: ${count} tests passed`);
checks.done(count);
