'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-restore-caches-'));
const cwd = process.cwd(); process.chdir(root); process.env.LOG_TO_FILE = 'false'; process.env.ENC_KEY_FILE = path.join(root, 'key');
const database = require('../modules/database');
const { restoreDatabase } = require('../modules/backup');
const work = require('../modules/databaseWork');
const limiter = require('../modules/pvoutput/rateLimiter');
function fixture(extra = '') {
  try { database.getDb().close(); } catch (_) {}
  fs.rmSync('data', { recursive: true, force: true });
  database.initializeDatabase();
  const file = path.join(root, 'input-' + Math.random() + '.db'), db = new Database(file);
  db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE metrics(timestamp INTEGER NOT NULL,metric TEXT NOT NULL,value REAL,PRIMARY KEY(timestamp,metric));
    CREATE TABLE latest_metrics(metric TEXT PRIMARY KEY,value REAL,timestamp INTEGER);` + extra);
  db.close(); return file;
}
after(() => { try { require('../modules/pvoutput').stop(); require('../modules/notifications').stop(); database.getDb().close(); } catch (_) {} process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });

test('retired PVOutput headers cannot alter or persist the replacement rate pool', async () => {
  const input = fixture(); limiter._test.reset(); limiter.init(database.getDb());
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = work.run(async () => { await gate; limiter.handleRateLimitExceeded('general', Math.floor(Date.now() / 1000) + 3600); });
  await restoreDatabase(input, { lifecycle: { resume() { limiter.init(database.getDb()); } } });
  release(); await pending;
  assert.equal(limiter.getState().general.remaining, 60);
  assert.equal(database.getConfig('pvoutput_rate_limit_state'), '');
});

test('a replacement with no rate state starts with defaults rather than the prior pool', async () => {
  const input = fixture(); limiter._test.reset(); limiter.init(database.getDb());
  limiter.handleRateLimitExceeded('general', Math.floor(Date.now() / 1000) + 3600);
  await restoreDatabase(input, { lifecycle: { resume() { limiter.init(database.getDb()); } } });
  assert.equal(limiter.getState().general.remaining, 60);
});

test('restoring disabled PVOutput clears the prior enabled client configuration', async () => {
  const input = fixture(); const pv = require('../modules/pvoutput');
  database.setConfig('pvoutput_config', JSON.stringify({ enabled: true, api_key: 'fixture', system_id: '42', timezone: 'UTC' }));
  database.setConfig('pvoutput_rate_limit_state', JSON.stringify({ general: { remaining: 0, limit: 60, resetAt: Math.floor(Date.now() / 1000) + 86400 } }));
  pv.start(); // locked pool suppresses all initial requests
  const server = http.createServer(express().use(pv.router));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await restoreDatabase(input, { lifecycle: { pause() { pv.stop(); }, resume() { pv.start(); } } });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/status');
    assert.equal((await response.json()).enabled, false);
  } finally { pv.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('notification restart reloads only restored state and registers one event delivery', async () => {
  const input = fixture(); const notifications = require('../modules/notifications'), store = require('../modules/notifications/store');
  store.saveState({ metric: { old: { sig: 'old', phase: 'firing' } } }); notifications.init();
  const candidate = new Database(input);
  candidate.prepare('INSERT INTO config VALUES(?,?)').run('notification_state', JSON.stringify({ metric: { restored: { sig: 'new', phase: 'idle' } } })); candidate.close();
  await restoreDatabase(input, { lifecycle: { pause() { notifications.stop(); }, resume() { notifications.init(); } } });
  assert.deepEqual(Object.keys(notifications._evaluator.exportState()), ['restored']);
  store.saveRules([{ id: 'one', name: 'one', kind: 'event', enabled: true, event: 'source.online', channels: ['local'], cooldown_s: 0 }]);
  store.saveChannels([{ id: 'local', name: 'local non-network sink', type: 'unsupported-fixture', enabled: true }]);
  require('../modules/notifications/events').emitEvent('source.online');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(database.getDb().prepare('SELECT COUNT(*) AS n FROM notification_log WHERE rule_id=?').get('one').n, 1);
  notifications.stop();
});

test('device-control auditing creates its table for the replacement handle', async () => {
  const input = fixture(), controls = require('../modules/deviceControls');
  controls.logAttempt({ source: 'fixture original', outcome: 'refused' });
  await restoreDatabase(input);
  controls.logAttempt({ source: 'fixture restored', outcome: 'refused' });
  assert.equal(controls.recentLog()[0].source, 'fixture restored');
});

test('a cached dashboard response cannot outlive the DB handle it describes', async () => {
  const input = fixture("INSERT INTO latest_metrics VALUES('restored metric',88,1700000000)");
  const routes = require('../routes/metrics'), now = Date.now;
  Date.now = () => 1700000000000;
  try {
    assert.equal((await routes.sharedDashboardState()).metrics['restored metric'], undefined);
    await restoreDatabase(input);
    assert.equal((await routes.sharedDashboardState()).metrics['restored metric'].value, 88);
  } finally { Date.now = now; }
});

test('restored log settings cancel the old request temporary-debug timer', () => {
  fixture(); const logs = require('../routes/logs');
  database.setConfig('log_level', 'warn'); logs.changeLevel('debug');
  try { assert.notEqual(logs._state().revertAt, null); logs.init(); assert.equal(logs._state().revertAt, null); }
  finally { logs.changeLevel('info'); }
});

test('the session store creates its table again after a replacement without sessions', async () => {
  const input = fixture(), store = require('../modules/sessionStore').createSessionStore(require('express-session'));
  const write = sid => new Promise((resolve, reject) => store.set(sid, { authenticated: true }, err => err ? reject(err) : resolve()));
  await write('original'); await restoreDatabase(input); await write('restored');
  assert.equal(database.getDb().prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid=?').get('restored').n, 1);
});

test('a failed combined-energy flush keeps its buffer for retry before live closure', () => {
  fixture(); const cm = require('../modules/combinedMetrics'), db = database.getDb(), now = Math.floor(Date.now() / 1000);
  database.setConfig('combined_metrics', JSON.stringify([{ id: 'sum', name: 'total', unit: 'kWh', fn: 'sum', inputs: ['part'] }]));
  const put = db.prepare('INSERT OR REPLACE INTO latest_metrics(metric,value,timestamp) VALUES(?,?,?)');
  put.run('part', 1, now); cm.runCombinedMetrics(now); cm.flushPartDays();
  put.run('part', 2, now + 1); cm.runCombinedMetrics(now + 1);
  db.exec("CREATE TRIGGER reject_parts BEFORE UPDATE ON combined_part_daily BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
  assert.throws(() => cm.flushPartDays(), /fixture disk failure/);
  db.exec('DROP TRIGGER reject_parts'); cm.flushPartDays();
  assert.equal(db.prepare('SELECT kwh FROM combined_part_daily WHERE total=? AND part=?').get('total', 'part').kwh, 2);
});

test('a retired forecast failure cannot populate the restored site negative cache', async () => {
  const input = fixture(), solar = require('../modules/solar'), originalFetch = global.fetch;
  const config = { forecast_enabled: 'true', solar_capacity_kwp: '5', solcast_api_key: 'fixture', solcast_resource_id: 'fixture' };
  for (const [key, value] of Object.entries(config)) database.setConfig(key, value);
  const candidate = new Database(input);
  for (const [key, value] of Object.entries(config)) candidate.prepare('INSERT INTO config VALUES(?,?)').run(key, value);
  candidate.close(); solar.clearForecastCache();
  let finish, started; const waiting = new Promise(r => { started = r; }); let calls = 0;
  global.fetch = async () => { calls++; if (calls === 1) { started(); return new Promise(r => { finish = r; }); } return new Response(JSON.stringify({ forecasts: [] }), { status: 200 }); };
  try {
    const old = work.run(() => solar.getSolarForecast('solcast')).then(value => ({ value }), error => ({ error }));
    await waiting;
    await restoreDatabase(input, { lifecycle: { resume() { solar.clearForecastCache(); } } });
    finish(new Response('', { status: 429 })); await old;
    const selected = await work.run(() => solar.getSolarForecast('solcast'));
    assert.equal(calls, 2, 'a retired 429 must not suppress the restored site request');
    assert.equal(selected.source, 'solcast');
  } finally { global.fetch = originalFetch; solar.clearForecastCache(); }
});

test('restore does not overlap an outstanding Bluetooth BMS read with replacement polling', async () => {
  const input = fixture(), ble = require('../modules/ble'), bms = require('../modules/bms');
  const wasConfigured = ble.isConfigured, wasRead = ble.readBms;
  const devices = [{ name: 'pack', enabled: true, address: 'AA:BB:CC:DD:EE:FF' }];
  database.setConfig('bms_devices', JSON.stringify(devices));
  const candidate = new Database(input); candidate.prepare('INSERT INTO config VALUES(?,?)').run('bms_devices', JSON.stringify(devices)); candidate.close();
  let finish, started, calls = 0;
  const waiting = new Promise(r => { started = r; });
  ble.isConfigured = () => true;
  ble.readBms = async () => { calls++; if (calls === 1) { started(); return new Promise(r => { finish = r; }); } return { voltage: 52 }; };
  try {
    const pending = work.run(() => bms.pollBMS()); await waiting;
    await restoreDatabase(input, { lifecycle: { pause() { bms.stopBmsPolling(); }, resume() { bms.startBmsPolling(); } } });
    assert.equal(calls, 1, 'new device I/O must wait for the outstanding read');
    finish({ voltage: 50 }); await pending;
    await work.run(() => bms.pollBMS());
    database.flushMetrics();
    assert.equal(calls, 2);
    assert.equal(database.getDb().prepare('SELECT value FROM latest_metrics WHERE metric=?').get('bms_pack_voltage').value, 52);
  } finally { if (finish) finish({ voltage: 50 }); bms.stopBmsPolling(); ble.isConfigured = wasConfigured; ble.readBms = wasRead; }
});

test('restore does not overlap an outstanding wired BMS port open with replacement polling', async () => {
  const input = fixture(), { SerialPort } = require('serialport'), wired = require('../modules/bmsWired');
  const originalOpen = SerialPort.prototype.open;
  const devices = [{ name: 'wired-pack', enabled: true, transport: 'wired', serial_path: '/fixture/no-hardware', profile: 'bms-modbus-rtu' }];
  database.setConfig('bms_devices', JSON.stringify(devices));
  const candidate = new Database(input); candidate.prepare('INSERT INTO config VALUES(?,?)').run('bms_devices', JSON.stringify(devices)); candidate.close();
  let finish, started, calls = 0; const waiting = new Promise(r => { started = r; });
  SerialPort.prototype.open = function(callback) { calls++; if (calls === 1) { finish = callback; started(); } else callback(new Error('fixture refused open')); };
  try {
    const pending = work.run(() => wired.pollBmsWired()); await waiting;
    await restoreDatabase(input, { lifecycle: { pause() { wired.stopBmsWiredPolling(); }, resume() { wired.startBmsWiredPolling(); } } });
    assert.equal(calls, 1, 'the old serial open still owns the device operation');
    finish(new Error('fixture refused open')); await pending;
    await work.run(() => wired.pollBmsWired()); assert.equal(calls, 2);
  } finally { if (finish) finish(new Error('fixture refused open')); wired.stopBmsWiredPolling(); SerialPort.prototype.open = originalOpen; }
});
