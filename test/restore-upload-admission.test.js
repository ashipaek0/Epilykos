'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { restoreUploadAdmission } = require('../modules/restorePreflight');
const MiB = 1024 * 1024;
test('upload declaration includes remaining input and live rollback without imposing an appliance floor on generic installs', () => {
  const original = fs.statfsSync, env = process.env.EPILYKOS_MAINTENANCE_LOCK;
  const db = { pragma(name) { return name === 'page_size' ? 4096 : 256; } };
  fs.statfsSync = () => ({ blocks: 100n * BigInt(MiB), bavail: 64n * BigInt(MiB), bsize: 1n });
  delete process.env.EPILYKOS_MAINTENANCE_LOCK;
  try {
    assert.equal(restoreUploadAdmission(db, '.', null).maxBytes, Math.floor(31 * MiB / 3));
    assert.throws(() => restoreUploadAdmission(db, '.', 11 * MiB), error => error.status === 507);
    assert.doesNotThrow(() => restoreUploadAdmission(db, '.', 11 * MiB, 2 * MiB));
    process.env.EPILYKOS_MAINTENANCE_LOCK = '/fixture/lock';
    assert.throws(() => restoreUploadAdmission(db, '.', 512), error => error.status === 507);
  } finally { fs.statfsSync = original; if (env === undefined) delete process.env.EPILYKOS_MAINTENANCE_LOCK; else process.env.EPILYKOS_MAINTENANCE_LOCK = env; }
});
