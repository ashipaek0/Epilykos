'use strict';
const checks = require('./_checks');
// Settings → Logs: the in-memory lines, secrets hidden, the level changed while
// running (and debug turning itself off), downloads and the diagnostics file.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-logs-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
delete process.env.LOG_LEVEL;
const express = require('express');
const database = require('../modules/database');
database.initializeDatabase();
const { logger } = require('../modules/logger');
const logBuffer = require('../modules/logBuffer');
const logs = require('../routes/logs');

// Built at runtime so no file holds a token-shaped string (secret scanners).
const fakeToken = `${'9'.repeat(9)}:${'x'.repeat(35)}`;
const localKey = 'q' + 'w'.repeat(14) + 'e';

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  // Lines from the logger and from console.*, once each, with a source.
  logBuffer._reset();
  logger.info('[dongle] Phocos 1: poll failed — timeout');
  console.log('Loaded 15 Modbus profile(s).');
  console.warn('BMS poll error for Pack: not found');
  logger.debug('[ble] hidden while the level is info');
  let all = logBuffer.read().entries;
  assert.deepEqual(all.map(e => [e.level, e.source]), [['info', 'dongle'], ['info', 'app'], ['warn', 'bms']]);
  assert.equal(logBuffer.read({ level: 'warn' }).entries.length, 1, 'warnings and errors only');
  assert.equal(logBuffer.read({ source: 'dongle' }).entries.length, 1);
  assert.equal(logBuffer.read({ q: 'MODBUS' }).entries.length, 1, 'search ignores case');
  assert.equal(logBuffer.read({ after: all[1].seq }).entries.length, 1, 'only lines after the last one seen');
  console.log('ok - lines are kept from the logger and console, filtered by level, source and text');

  // Secrets: token shapes, and configured values wherever they appear.
  database.setConfig('tuya_devices', JSON.stringify([{ name: 'Plug', local_key: localKey }]));
  database.setConfig('notification_channels', JSON.stringify([{ id: 'c1', type: 'telegram', bot_token: fakeToken }]));
  logs.init();
  logger.warn(`Tuya bridge failed: python3 tuya_bridge.py poll abc 10.0.0.2 ${localKey} 3.3`);
  logger.info(`sending to https://api.telegram.org/bot${fakeToken}/sendMessage`);
  logger.info('login with password=hunter2hunter2 and Authorization: Bearer abcdefghijklmnop');
  const text = logBuffer.asText();
  assert.ok(!text.includes(localKey) && !text.includes(fakeToken) && !text.includes('hunter2hunter2') && !text.includes('abcdefghijklmnop'), text);
  assert.match(text, /\[hidden\]/);
  console.log('ok - secrets are hidden before lines are kept');

  // The routes, behind a plain app (server.js adds isAuthenticated).
  const app = express();
  app.use('/api/logs', logs.router());
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    let r = await request(server, 'GET', '/api/logs?level=warn');
    assert.equal(r.status, 200);
    let body = r.json();
    assert.ok(body.entries.every(e => ['warn', 'error'].includes(e.level)));
    assert.equal(body.level, 'info'); assert.ok(body.sources.includes('dongle'));

    r = await request(server, 'POST', '/api/logs/level', { level: 'loud' });
    assert.equal(r.status, 400);
    r = await request(server, 'POST', '/api/logs/level', { level: 'warn' });
    assert.equal(r.json().level, 'warn');
    assert.equal(database.getConfig('log_level'), 'warn', 'saved');
    assert.ok(logger.transports.every(t => t.level === 'warn'), 'every transport follows');
    logger.info('not kept at warn');
    assert.ok(!logBuffer.asText().includes('not kept at warn'));

    r = await request(server, 'POST', '/api/logs/level', { level: 'debug' });
    body = r.json();
    assert.equal(body.level, 'debug'); assert.equal(body.baseLevel, 'warn', 'debug is never saved');
    assert.ok(body.revertAt > Date.now() + 29 * 60000 && body.revertAt <= Date.now() + 30 * 60000);
    assert.equal(database.getConfig('log_level'), 'warn');
    logger.debug('[ble] visible at debug');
    assert.match(logBuffer.asText(), /visible at debug/);

    r = await request(server, 'GET', '/api/logs/download');
    assert.match(r.headers['content-disposition'], /attachment; filename="epilykos-log-/);
    assert.ok(!r.text.includes(localKey));

    r = await request(server, 'GET', '/api/logs/diagnostics');
    const diag = r.json();
    assert.match(r.headers['content-disposition'], /epilykos-diagnostics-/);
    assert.equal(diag.logLevel.current, 'debug'); assert.equal(diag.logLevel.saved, 'warn');
    assert.equal(diag.settings.tuya_devices[0].local_key, '[hidden]');
    assert.equal(diag.settings.tuya_devices[0].name, 'Plug', 'other fields stay');
    assert.equal(diag.settings.notification_channels[0].bot_token, '[hidden]');
    assert.ok(!r.text.includes(localKey) && !r.text.includes(fakeToken), 'no secret anywhere in the file');
    assert.ok(Array.isArray(diag.log) && diag.log.length > 0);
    console.log('ok - routes: read, level (saved; debug temporary), download and diagnostics without secrets');

    await request(server, 'POST', '/api/logs/level', { level: 'info' });
    assert.equal(logs._state().revertAt, null, 'choosing a level cancels the debug timer');
  } finally { server.close(); }

  // Settings page wiring.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /data-section="logs"/); assert.match(html, /js\/logs-settings\.js/);
  assert.match(srv, /skip: req => req\.originalUrl\.startsWith\('\/api\/logs'\)/, 'the page\'s own polling is not logged');
  assert.match(srv, /app\.use\('\/api\/logs', isAuthenticated, require\('\.\/routes\/logs'\)\.router\(\)\)/, 'signed-in only');
  console.log('ok - Settings has the Logs page, behind sign-in');
  checks.done();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
