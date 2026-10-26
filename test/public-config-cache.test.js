'use strict';
const checks = require('./_checks');
// Appearance settings (square corners, background colour and image, title) are
// read from /api/public-config. A copy kept for five minutes made a change in
// Settings look like it did nothing, even after reloading the dashboard.
const assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs');
const dbModule = require('../modules/database');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epk-public-config-'));
dbModule.initializeDatabase({ filePath: path.join(dir, 'energy.db') });
const { router } = require('../routes/metrics');
const handler = router.stack.find(layer => layer.route?.path === '/public-config').route.stack[0].handle;
const headers = {};
let body;
handler({}, { set(k, v) { headers[k] = v; return this; }, json(v) { body = v; return this; }, status() { return this; } });
assert.ok(body && 'square_corners' in body && 'dashboard_bg_color_light' in body && 'dashboard_bg_image' in body);
assert.equal(headers['Cache-Control'], 'no-cache', 'the browser must ask again, not reuse a stored copy');
console.log('ok - public config is never served from a stored copy');
checks.done();
