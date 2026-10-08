'use strict';
const checks = require('./_checks');
/**
 * Device controls (modules/deviceControls.js, routes/controls.js) against a
 * fake LuxPower dongle with polling running, as on a real install:
 * - nothing is written while "Allow device changes" is off, on any path;
 * - a listed setting is read first, range/step/relations are checked, a
 *   reading outside the range blocks the change, a stale page is caught,
 *   and the value is read back (a device that limits it is reported);
 * - writes use polling's own connection, never a second one (issue #107);
 * - raw register writes need the expert switch, which can't be on alone;
 * - the HTTP routes need the password unlock, and every attempt is logged;
 * - addresses and values are whole numbers 0..65535, never "0 on a typo".
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-controls-'));
process.chdir(tmp);
process.env.SETTINGS_PASSWORD = 'made-up-test-password';
const database = require('../modules/database');
database.initializeDatabase();
const { startFakeDongle } = require('./fixtures/fake-luxpower-dongle');
const dongle = require('../modules/dongle');
const controls = require('../modules/deviceControls');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }
const wait = ms => new Promise(r => setTimeout(r, ms));
const lastLog = () => controls.recentLog(1)[0];

(async () => {
  const fake = await startFakeDongle({ holding: { 0x69: 20, 0x7D: 15, 0x4B: 90, 0xA0: 30, 0xA1: 90, 0xC4: 25, 0xC5: 85, 0xE3: 100 }, limit: { 0xE3: 95 } });
  database.setConfig('dongle_config', JSON.stringify([
    { name: 'Lux', enabled: true, profile: 'luxpower-geta', transport: 'luxpower-tcp', host: '127.0.0.1', port: fake.port,
      dongle_serial: fake.dongleSerial, inverter_serial: fake.inverterSerial, poll_interval: 3600 },
    { name: 'Plain', enabled: true, profile: 'deye-hybrid', transport: 'modbus-tcp', host: '127.0.0.1', port: 1, poll_interval: 3600 }
  ]));
  database.setConfig('modbus_devices', JSON.stringify([{ name: 'Meter', enabled: true, host: '127.0.0.1', port: 1 }]));
  dongle.startDonglePolling();
  for (let i = 0; i < 50 && fake.connections.opened === 0; i++) await wait(20);
  await wait(200);
  const req = { ip: '127.0.0.1', session: {} };

  try {
    await check('register words: whole numbers 0..65535 only, never 0 for a typo', () => {
      const w = dongle.registerWord;
      assert.strictEqual(w('12'), 12); assert.strictEqual(w(12), 12); assert.strictEqual(w('0x69'), 105); assert.strictEqual(w(' 7 '), 7);
      for (const bad of ['', ' ', 'abc', '12abc', '-1', '65536', 1.5, '1.5', null, undefined, '1e3', '0x', '0x10000', NaN]) assert.strictEqual(w(bad), null, String(bad));
      assert.strictEqual(w('0x10', { decimalOnly: true }), null);
      assert.strictEqual(w('65535', { decimalOnly: true }), 65535);
    });

    await check('switched off (the default): every write path refuses, nothing reaches the device', async () => {
      assert.strictEqual(controls.writesEnabled(), false);
      const r = await controls.changeSetting({ device: 'Lux', setting: 'eod_soc', value: 25 }, req);
      assert.strictEqual(r.success, false); assert.match(r.error, /turned off/);
      assert.match((await dongle.executeDongleAction('Lux', 'holding:0x0069', 25)).error, /turned off/);
      assert.match((await dongle.executeDongleAction('Plain', '100', 5)).error, /turned off/);
      assert.match((await dongle.writeDongleSetting('Lux', '0x0069', 'holding', 25)).error, /turned off/);
      assert.match((await dongle.writeLuxpowerRaw('Lux', '0x0040', 5)).error, /turned off/);
      assert.match((await require('../modules/modbus').executeModbusAction('Meter', '10', '5')).error, /turned off/);
      assert.match((await require('../modules/rs232').executeRs232Action('nope', '01')).error, /not found/);
      assert.strictEqual(fake.writes.length, 0);
      assert.strictEqual(lastLog().outcome, 'refused');
    });

    await check('reading a setting works while switched off, through the polling connection', async () => {
      const r = await controls.readSetting('Lux', 'eod_soc');
      assert.deepStrictEqual(r, { value: 20, raw: 20, inRange: true });
      assert.strictEqual(fake.connections.opened, 1, 'one connection: polling\'s');
    });

    await check('the settings list: battery charge levels only, with ranges', () => {
      const lux = controls.listDevices().find(d => d.name === 'Lux');
      assert.strictEqual(lux.settings.length, 8);
      assert.ok(lux.settings.every(s => s.unit === '%' && s.min >= 0 && s.max <= 100));
      assert.ok(!lux.settings.some(s => /eps_(voltage|frequency)/.test(s.name)));
      assert.ok(controls.listDevices().some(d => d.kind === 'modbus' && d.name === 'Meter' && d.rawWrites));
    });

    controls.setSwitches({ enabled: true });

    await check('a listed setting: read, write on the same connection, read back', async () => {
      const r = await controls.changeSetting({ device: 'Lux', setting: 'eod_soc', value: 25, expected: 20 }, req);
      assert.deepStrictEqual(r, { success: true, value: 25 });
      assert.strictEqual(fake.holding.get(0x69), 25);
      assert.deepStrictEqual(fake.writes, [{ register: 0x69, value: 25 }]);
      assert.strictEqual(fake.connections.opened, 1, 'no second connection for the write (issue #107)');
      assert.strictEqual(fake.connections.refused, 0);
      const log = lastLog();
      assert.strictEqual(log.outcome, 'done'); assert.strictEqual(log.old_value, '20'); assert.strictEqual(log.new_value, '25'); assert.strictEqual(log.device, 'Lux');
    });

    await check('out of range, off-step, not a number, empty: refused before anything is sent', async () => {
      for (const [value, re] of [[95, /between 10 and 90/], [5, /between 10 and 90/], [25.5, /steps of 1/], ['abc', /number/], ['', /number/], [null, /number/]]) {
        const r = await controls.changeSetting({ device: 'Lux', setting: 'eod_soc', value }, req);
        assert.strictEqual(r.success, false, String(value)); assert.match(r.error, re, String(value));
      }
      assert.strictEqual(fake.writes.length, 1);
    });

    await check('a page showing an old value is caught; the same value writes nothing', async () => {
      const stale = await controls.changeSetting({ device: 'Lux', setting: 'eod_soc', value: 30, expected: 20 }, req);
      assert.strictEqual(stale.success, false); assert.match(stale.error, /changed since you looked/); assert.strictEqual(stale.current, 25);
      const same = await controls.changeSetting({ device: 'Lux', setting: 'eod_soc', value: 25, expected: 25 }, req);
      assert.deepStrictEqual(same, { success: true, value: 25, unchanged: true });
      assert.strictEqual(fake.writes.length, 1);
    });

    await check('start must stay below stop (and stop above start)', async () => {
      const a = await controls.changeSetting({ device: 'Lux', setting: 'ac_charge_start_soc', value: 90 }, req);
      assert.strictEqual(a.success, false); assert.match(a.error, /below Grid charging stops at \(90 %\)/);
      const b = await controls.changeSetting({ device: 'Lux', setting: 'ac_charge_end_soc', value: 20 }, req);
      assert.strictEqual(b.success, false); assert.match(b.error, /above Grid charging starts below \(30 %\)/);
      const ok = await controls.changeSetting({ device: 'Lux', setting: 'ac_charge_start_soc', value: 40 }, req);
      assert.strictEqual(ok.success, true);
      assert.strictEqual(fake.holding.get(0xA0), 40);
    });

    await check('a reading outside the setting\'s range blocks the change (the register may mean something else here)', async () => {
      fake.holding.set(0x7D, 500);
      const n = fake.writes.length;
      const r = await controls.changeSetting({ device: 'Lux', setting: 'soc_low_limit_eps_discharge', value: 20 }, req);
      assert.strictEqual(r.success, false); assert.match(r.error, /reports 500 %.*outside 5–90/);
      assert.strictEqual(fake.writes.length, n);
      assert.strictEqual((await controls.readSetting('Lux', 'soc_low_limit_eps_discharge')).inRange, false);
      fake.holding.set(0x7D, 15);
    });

    await check('a device that limits the value: read back differs, reported as a failure', async () => {
      const r = await controls.changeSetting({ device: 'Lux', setting: 'battery_stop_charge_soc', value: 98 }, req);
      assert.strictEqual(r.success, false); assert.strictEqual(r.written, true); assert.strictEqual(r.value, 95);
      assert.match(r.error, /now reports 95 %/);
      assert.strictEqual(lastLog().outcome, 'failed');
    });

    await check('unknown device or setting, and unlisted registers, are refused', async () => {
      assert.match((await controls.changeSetting({ device: 'Nope', setting: 'eod_soc', value: 20 }, req)).error, /not found/);
      assert.match((await controls.changeSetting({ device: 'Lux', setting: 'eps_voltage_set', value: 230 }, req)).error, /not in this device's list/);
      assert.match((await dongle.writeDongleSetting('Lux', '0x005A', 'holding', 230)).error, /not in this device's list/);
      assert.match((await dongle.executeDongleAction('Lux', 'holding:0x005A', 230)).error, /not writable/);
    });

    await check('raw register writes need the expert switch; expert can\'t stay on without writes', async () => {
      assert.match((await controls.rawWrite({ kind: 'dongle', device: 'Lux', register: '0x0040', value: '50' }, req)).error, /expert/);
      assert.match((await dongle.executeDongleAction('Plain', '100', 5)).error, /expert/);
      assert.match((await require('../modules/modbus').executeModbusAction('Meter', '10', '5')).error, /expert/);
      controls.setSwitches({ expert: true });
      assert.strictEqual(controls.expertEnabled(), true);
      const r = await controls.rawWrite({ kind: 'dongle', device: 'Lux', register: '0x0040', value: '50' }, req);
      assert.deepStrictEqual(r, { success: true, before: 0, after: 50 });
      assert.strictEqual(fake.holding.get(0x40), 50);
      assert.match((await controls.rawWrite({ kind: 'dongle', device: 'Lux', register: '0x0040', value: '5x' }, req)).error, /whole number/);
      assert.match((await dongle.executeDongleAction('Plain', '100', 'abc')).error, /whole number/);
      assert.match((await require('../modules/modbus').executeModbusAction('Meter', 'x', '5')).error, /Invalid register/);
      controls.setSwitches({ enabled: false });
      assert.strictEqual(controls.expertEnabled(), false);
      assert.strictEqual(database.getConfig('device_writes_expert'), 'false');
      controls.setSwitches({ enabled: true });
      assert.strictEqual(controls.expertEnabled(), false, 'turning writes back on does not bring expert back');
    });

    await check('HTTP: reads need sign-in only; changes and switches need the password unlock', async () => {
      const express = require('express'), session = require('express-session'), http = require('http');
      const app = express();
      app.use(express.json());
      app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
      app.get('/signin', (q, s) => { q.session.authenticated = true; s.send('ok'); });
      app.get('/expire', (q, s) => { q.session.controlsUnlockedUntil = Date.now() - 1; s.send('ok'); });
      const { isAuthenticated } = require('../modules/sessionAuth');
      app.use('/api/controls', isAuthenticated, require('../routes/controls'));
      const server = app.listen(0, '127.0.0.1');
      await new Promise(r => server.once('listening', r));
      let cookie = '';
      const call = (method, p, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
          headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
          let t = ''; res.on('data', c => { t += c; });
          res.on('end', () => { if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, body: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
      });
      try {
        assert.strictEqual((await call('GET', '/api/controls/status')).status, 401, 'signed out');
        assert.strictEqual((await call('POST', '/api/controls/unlock', { password: 'made-up-test-password' })).status, 401, 'signed out cannot unlock');
        await call('GET', '/signin');
        const st = await call('GET', '/api/controls/status');
        assert.strictEqual(st.status, 200); assert.strictEqual(st.body.unlockedUntil, null); assert.strictEqual(st.body.writesEnabled, true);
        const read = await call('POST', '/api/controls/read', { device: 'Lux', setting: 'eod_soc' });
        assert.strictEqual(read.status, 200); assert.strictEqual(read.body.value, 25);
        const locked = await call('POST', '/api/controls/change', { device: 'Lux', setting: 'eod_soc', value: 30, expected: 25 });
        assert.strictEqual(locked.status, 423); assert.strictEqual(locked.body.locked, true);
        assert.strictEqual((await call('POST', '/api/controls/switches', { enabled: false })).status, 423);
        assert.strictEqual((await call('POST', '/api/controls/raw-write', { device: 'Lux', register: '0x40', value: 1 })).status, 423);
        const wrong = await call('POST', '/api/controls/unlock', { password: 'nope' });
        assert.strictEqual(wrong.status, 401);
        assert.strictEqual(lastLog().source, 'unlock'); assert.strictEqual(lastLog().outcome, 'refused');
        const un = await call('POST', '/api/controls/unlock', { password: 'made-up-test-password' });
        assert.strictEqual(un.status, 200); assert.ok(un.body.unlockedUntil > Date.now() + 4 * 60000 && un.body.unlockedUntil <= Date.now() + 5 * 60000 + 1000);
        const changed = await call('POST', '/api/controls/change', { device: 'Lux', setting: 'eod_soc', value: 30, expected: 25 });
        assert.strictEqual(changed.status, 200); assert.strictEqual(changed.body.value, 30);
        assert.strictEqual(fake.holding.get(0x69), 30);
        const refused = await call('POST', '/api/controls/change', { device: 'Lux', setting: 'eod_soc', value: 99 });
        assert.strictEqual(refused.status, 409);
        const exp = await call('POST', '/api/controls/switches', { expert: true });
        assert.strictEqual(exp.status, 200); assert.strictEqual(exp.body.expertEnabled, true);
        const rr = await call('POST', '/api/controls/raw-read', { device: 'Lux', register: '0x0069' });
        assert.strictEqual(rr.status, 200); assert.strictEqual(rr.body.value, 30);
        assert.strictEqual((await call('POST', '/api/controls/switches', {})).status, 400);
        await call('GET', '/expire');
        assert.strictEqual((await call('POST', '/api/controls/change', { device: 'Lux', setting: 'eod_soc', value: 31 })).status, 423, 'the unlock expires');
        await call('POST', '/api/controls/unlock', { password: 'made-up-test-password' });
        await call('POST', '/api/controls/lock', {});
        assert.strictEqual((await call('POST', '/api/controls/change', { device: 'Lux', setting: 'eod_soc', value: 31 })).status, 423, 'lock now');
        const log = await call('GET', '/api/controls/log?limit=500');
        assert.ok(log.body.entries.length >= 20);
        assert.ok(log.body.entries.every(e => ['done', 'refused', 'failed', 'unverified'].includes(e.outcome)));
        assert.ok(log.body.entries.some(e => e.source === 'switches'));
      } finally { server.close(); }
    });

    await check('without polling: a read opens its own connection and closes it', async () => {
      dongle.stopDonglePolling();
      await wait(100);
      const opened = fake.connections.opened;
      const r = await controls.readSetting('Lux', 'eod_soc');
      assert.strictEqual(r.value, 30);
      assert.strictEqual(fake.connections.opened, opened + 1);
    });

    await check('server.js: /api/action needs the unlock and logs; Settings no longer writes directly', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert.match(src, /app\.post\('\/api\/action', isAuthenticated, deviceControls\.requireUnlocked,/);
      assert.match(src, /app\.use\('\/api\/controls', isAuthenticated, require\('\.\/routes\/controls'\)\)/);
      assert.ok((src.match(/logged\('(done|failed)'/g) || []).length >= 3);
      const settings = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.js'), 'utf8');
      assert.ok(!/sendDongleRegisterWrite/.test(settings));
      assert.match(settings, /link\.href = '\/controls'/);
      for (const f of ['modules/dongle.js', 'modules/modbus.js']) assert.ok(!/parseInt\(value\) \|\| 0/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), `${f}: no "0 on a typo"`);
    });
  } finally {
    dongle.stopDonglePolling();
    await fake.close();
  }
  console.log(`device controls: ${passed} passed`);
  checks.done(passed);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
