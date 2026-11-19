'use strict';
const checks = require('./_checks');
// Home Assistant discovery: the rules, the publisher against a fake broker, and the settings route.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const ha = require('../modules/haDiscovery');

// ── Rules ────────────────────────────────────────────────────────────────
const cls = (m, u) => ha.classify(m, u);
assert.deepEqual(cls('pv_power', 'W'), { unit: 'W', deviceClass: 'power', stateClass: 'measurement' });
assert.deepEqual(cls('daily_solar', 'kWh'), { unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing' });
assert.equal(cls('battery_voltage', 'V').deviceClass, 'voltage');
assert.equal(cls('grid_frequency', 'Hz').deviceClass, 'frequency');
assert.equal(cls('inverter_temp', '°C').deviceClass, 'temperature');
assert.equal(cls('battery_soc', '%').deviceClass, 'battery');
assert.equal(cls('load_percent', '%').deviceClass, null, 'a percentage that is not a battery stays plain');
assert.equal(cls('battery_temp_percent', '%').deviceClass, null);
assert.deepEqual(cls('mystery', 'rpm'), { unit: 'rpm', deviceClass: null, stateClass: 'measurement' });
assert.deepEqual(cls('mode', ''), { unit: null, deviceClass: null, stateClass: null });
assert.deepEqual(cls('mode', null), { unit: null, deviceClass: null, stateClass: null });

assert.equal(ha.safe('PV Total/Power!'), 'pv_total_power');
assert.equal(ha.safe('', 'x'), 'x');
const cfg = ha.normalise({ enabled: true, broker: ' mqtt://h:1883 ', prefix: 'Home Assistant', node: 'My Node', mode: 'weird', interval: 99999 });
assert.deepEqual([cfg.broker, cfg.prefix, cfg.node, cfg.mode, cfg.interval], ['mqtt://h:1883', 'home_assistant', 'my_node', 'roles', 3600]);
assert.equal(ha.normalise(null).enabled, false);
assert.equal(ha.normalise({ interval: 0 }).interval, 1);
assert.equal(ha.normalise({ interval: 'x' }).interval, 10);
for (const ok of ['mqtt://a:1883', 'mqtts://a', 'ws://a:9001', 'wss://a/mqtt']) assert.equal(ha.validBroker(ok), true, ok);
for (const bad of ['', 'http://a', 'a:1883', 'mqtt://', 'javascript:alert(1)']) assert.equal(ha.validBroker(bad), false, bad);

const base = ha.normalise({ enabled: true, broker: 'mqtt://b', node: 'home' });
const t = ha.topics(base, 'pv power');
assert.deepEqual(t, { config: 'homeassistant/sensor/home/pv_power/config', state: 'epilykos/home/pv_power', availability: 'epilykos/home/status' });
const p = ha.discoveryPayload(base, { metric: 'battery_soc', value: 80, unit: '%', value_type: 'number' }, '1.3.4');
assert.equal(p.name, 'Battery soc'); assert.equal(p.unique_id, 'epilykos_home_battery_soc');
assert.equal(p.device_class, 'battery'); assert.equal(p.state_class, 'measurement'); assert.equal(p.unit_of_measurement, '%');
assert.deepEqual(p.device.identifiers, ['epilykos_home']); assert.equal(p.device.sw_version, '1.3.4');
assert.equal(p.availability_topic, 'epilykos/home/status'); assert.equal(p.has_entity_name, true);
const textual = ha.discoveryPayload(base, { metric: 'inverter_mode', value: null, value_text: 'Battery', value_type: 'string', unit: 'W' }, '');
assert.equal(textual.unit_of_measurement, undefined, 'a text value never claims a unit'); assert.equal(textual.device_class, undefined);
assert.equal(ha.stateText({ value: 1.234567, value_type: 'number' }), '1.2346');
assert.equal(ha.stateText({ value: 5, value_type: 'number' }), '5');
assert.equal(ha.stateText({ value: null, value_text: 'on', value_type: 'boolean' }), 'on');
assert.equal(ha.stateText({ value: null, value_text: null }), null);
assert.equal(ha.stateText({ value: NaN }), null);

const rows = [{ metric: 'pv_power', value: 1, value_type: 'number' }, { metric: 'junk', value: 2, value_type: 'number' }, { metric: 'empty', value: null, value_text: null }];
assert.deepEqual(ha.selectRows(rows, { mode: 'roles' }, { solar: 'pv_power', x: '' }).map(r => r.metric), ['pv_power']);
assert.deepEqual(ha.selectRows(rows, { mode: 'all' }, {}).map(r => r.metric), ['pv_power', 'junk'], 'empty ones are never published');
assert.deepEqual(ha.selectRows(rows, { mode: 'roles' }, null), []);

// ── The publisher, against a fake broker ─────────────────────────────────
function fakeBroker() {
  const state = { clients: [], published: [] };
  state.connect = (url, opts) => {
    const c = new EventEmitter();
    c.url = url; c.opts = opts; c.ended = false;
    c.publish = (topic, payload, o, cb) => { state.published.push({ topic, payload: String(payload), retain: o && o.retain, client: c }); if (typeof cb === 'function') cb(); };
    c.end = () => { c.ended = true; };
    state.clients.push(c);
    return c;
  };
  state.on = (topic) => state.published.filter(m => m.topic === topic);
  return state;
}
let clock = 1_000_000, stored = { enabled: true, broker: 'mqtt://b:1883', username: 'u', password: 'pw', node: 'home', mode: 'all', interval: 10 };
let latest = [{ metric: 'pv_power', value: 1500, value_type: 'number', unit: 'W' }, { metric: 'battery_soc', value: 80, value_type: 'number', unit: '%' }];
let flushed = null;
const broker = fakeBroker();
const svc = ha.createHaDiscovery({
  connect: broker.connect, readConfig: () => stored, readRoles: () => ({}), getLatest: () => latest,
  onFlushed: fn => { flushed = fn; return () => { flushed = null; }; }, version: '9.9.9', now: () => clock,
});

stored = { ...stored, enabled: false }; svc.start();
assert.equal(broker.clients.length, 0, 'off means no connection');
assert.equal(svc.status().state, 'off');
stored = { ...stored, enabled: true, broker: 'ftp://nope' }; svc.start();
assert.equal(svc.status().state, 'error'); assert.match(svc.status().error, /mqtt:\/\//); assert.equal(broker.clients.length, 0);
stored = { ...stored, broker: 'mqtt://b:1883' };

svc.start();
assert.equal(broker.clients.length, 1);
const c1 = broker.clients[0];
assert.equal(c1.opts.username, 'u'); assert.equal(c1.opts.password, 'pw');
assert.deepEqual([c1.opts.will.topic, c1.opts.will.payload, c1.opts.will.retain], ['epilykos/home/status', 'offline', true], 'a last will marks the sensors unavailable');
assert.equal(svc.status().state, 'connecting');
c1.emit('connect');
assert.equal(svc.status().state, 'connected');
assert.equal(broker.on('epilykos/home/status')[0].payload, 'online');
const cfgMsg = broker.on('homeassistant/sensor/home/pv_power/config');
assert.equal(cfgMsg.length, 1); assert.equal(cfgMsg[0].retain, true);
assert.equal(JSON.parse(cfgMsg[0].payload).device_class, 'power');
assert.equal(broker.on('epilykos/home/pv_power')[0].payload, '1500');
assert.equal(broker.on('epilykos/home/battery_soc')[0].payload, '80');
assert.equal(svc.status().sensors, 2);

// Only changes go out, and not faster than the interval.
const n0 = broker.published.length;
flushed(); assert.equal(broker.published.length, n0, 'nothing changed, nothing sent');
latest = [{ ...latest[0], value: 1600 }, latest[1]];
clock += 5_000; flushed(); assert.equal(broker.on('epilykos/home/pv_power').length, 1, 'inside the interval, held back');
clock += 6_000; flushed(); assert.equal(broker.on('epilykos/home/pv_power').length, 2); assert.equal(broker.on('epilykos/home/pv_power')[1].payload, '1600');
assert.equal(broker.on('homeassistant/sensor/home/pv_power/config').length, 1, 'the discovery message is not repeated');

// A new metric gets a sensor; one that disappears has its sensor removed.
latest = [...latest, { metric: 'grid_voltage', value: 230, value_type: 'number', unit: 'V' }];
flushed(); assert.equal(JSON.parse(broker.on('homeassistant/sensor/home/grid_voltage/config')[0].payload).device_class, 'voltage');
latest = latest.filter(r => r.metric !== 'battery_soc');
flushed();
assert.equal(broker.on('homeassistant/sensor/home/battery_soc/config').pop().payload, '', 'an empty retained message removes the sensor');
assert.equal(svc.status().sensors, 2);

// Reconnecting after a drop publishes everything again.
c1.emit('close'); assert.equal(svc.status().state, 'connecting');
const before = broker.on('homeassistant/sensor/home/pv_power/config').length;
c1.emit('connect'); assert.equal(broker.on('homeassistant/sensor/home/pv_power/config').length, before + 1);

// Roles mode publishes only the chosen metrics.
const roleSvc = ha.createHaDiscovery({ connect: broker.connect, readConfig: () => ({ ...stored, mode: 'roles' }), readRoles: () => ({ solar: 'pv_power' }), getLatest: () => latest, onFlushed: () => () => {}, now: () => clock });
roleSvc.start(); const c2 = broker.clients[broker.clients.length - 1]; c2.emit('connect');
assert.equal(roleSvc.status().sensors, 1);
roleSvc.stop();

// Stopping says goodbye.
svc.stop();
assert.equal(c1.ended, true); assert.equal(flushed, null, 'no longer listening for readings');
assert.equal(broker.on('epilykos/home/status').pop().payload, 'offline');
assert.equal(svc.status().state, 'off');

// Remove from Home Assistant: connected, and also when switched off.
svc.start(); const c3 = broker.clients[broker.clients.length - 1]; c3.emit('connect');
(async () => {
  const r1 = await svc.removeAll().catch(e => e);
  assert.ok(r1.removed >= 2, 'connected: clears what it published');
  assert.equal(broker.on('epilykos/home/status').pop().payload, '', 'and leaves no "offline" message behind');
  stored = { ...stored, enabled: false };
  const mark = broker.published.length;
  const pending = svc.removeAll();
  const tmp = broker.clients[broker.clients.length - 1];
  setImmediate(() => tmp.emit('connect'));
  const r2 = await pending;
  assert.ok(r2.removed >= 2, 'works with discovery switched off');
  const sent = broker.published.slice(mark);
  assert.ok(sent.some(m => m.topic === 'homeassistant/sensor/home/pv_power/config' && m.payload === ''), 'the sensor is cleared');
  assert.ok(sent.some(m => m.topic === 'epilykos/home/status' && m.payload === ''), 'and the availability topic');
  assert.equal(tmp.ended, true, 'the temporary connection is closed');
  stored = { ...stored, broker: '' };
  await assert.rejects(() => svc.removeAll(), /broker address/);

  // Test connection.
  stored = { ...stored, broker: 'mqtt://b:1883', password: 'saved-pw' };
  const tp = svc.test({ broker: 'mqtt://other:1883', password: '' });
  const tc = broker.clients[broker.clients.length - 1];
  assert.equal(tc.opts.password, 'saved-pw', 'an empty password uses the saved one');
  setImmediate(() => tc.emit('connect'));
  assert.deepEqual(await tp, { ok: true }); assert.equal(tc.ended, true);
  const tp2 = svc.test({ broker: 'mqtt://other:1883', password: 'typed' });
  const tc2 = broker.clients[broker.clients.length - 1];
  assert.equal(tc2.opts.password, 'typed');
  setImmediate(() => tc2.emit('error', new Error('Connection refused: Not authorized')));
  await assert.rejects(tp2, /Not authorized/);
  await assert.rejects(() => svc.test({ broker: 'http://x' }), /mqtt:\/\//);
  await assert.rejects(() => svc.test({ broker: '' }), /Enter the broker/);

  // ── The route: the password never leaves ──────────────────────────────
  const Module = require('module');
  const store = { ha_discovery: JSON.stringify({ enabled: true, broker: 'mqtt://b:1883', username: 'u', password: 'secret-pw', mode: 'all' }) };
  const dbPath = require.resolve('../modules/database'), svcPath = require.resolve('../modules/haDiscoveryService');
  const fakeSvc = { starts: 0, service() { return { start() { fakeSvc.starts++; }, status() { return { state: 'connected', error: '', sensors: 3 }; }, async removeAll() { return { removed: 3 }; }, async test(b) { if (b.broker === 'bad') throw new Error('nope'); return { ok: true }; } }; } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getConfig: k => store[k] || null, setConfig: (k, v) => { store[k] = v; } } };
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: fakeSvc };
  const app = express(); app.use(express.json()); app.use('/api/ha-discovery', require('../routes/haDiscovery'));
  const server = http.createServer(app).listen(0); const port = server.address().port;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); if (data) req.write(data); req.end();
  });
  let r = await call('GET', '/api/ha-discovery');
  assert.equal(r.status, 200); assert.doesNotMatch(r.text, /secret-pw/, 'GET never returns the password');
  assert.equal(JSON.parse(r.text).settings.hasPassword, true);
  r = await call('POST', '/api/ha-discovery/settings', { enabled: true, broker: 'mqtt://b:1883', username: 'u', password: '', mode: 'roles' });
  assert.equal(r.status, 200); assert.doesNotMatch(r.text, /secret-pw/);
  assert.equal(JSON.parse(store.ha_discovery).password, 'secret-pw', 'an empty password keeps the saved one for the same broker and user');
  assert.equal(JSON.parse(store.ha_discovery).mode, 'roles'); assert.equal(fakeSvc.starts, 1, 'saving restarts the publisher');
  await call('POST', '/api/ha-discovery/settings', { enabled: true, broker: 'mqtt://other:1883', username: 'u', password: '' });
  assert.equal(JSON.parse(store.ha_discovery).password, '', 'a different broker does not inherit the old password');
  await call('POST', '/api/ha-discovery/settings', { enabled: true, broker: 'mqtt://b:1883', username: 'u', password: 'new-pw' });
  assert.equal(JSON.parse(store.ha_discovery).password, 'new-pw');
  assert.equal((await call('POST', '/api/ha-discovery/settings', { enabled: true, broker: '' })).status, 400);
  assert.equal((await call('POST', '/api/ha-discovery/settings', { broker: 'http://x' })).status, 400);
  assert.equal((await call('POST', '/api/ha-discovery/test', { broker: 'bad' })).status, 422);
  r = await call('POST', '/api/ha-discovery/remove', {}); assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).removed, 3);
  assert.equal(JSON.parse(store.ha_discovery).enabled, false, 'remove switches discovery off');
  server.close();

  // ── Wiring ─────────────────────────────────────────────────────────────
  const root = path.join(__dirname, '..'); const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('server.js'), /app\.use\('\/api\/ha-discovery', isAuthenticated/, 'signed in only');
  assert.match(read('server.js'), /haDiscoveryService'\)\.start\(\)/); assert.match(read('server.js'), /haDiscoveryService'\)\.stop\(\)/);
  assert.match(read('modules/backup.js'), /haDiscoveryService'\)\.stop\(\)/, 'stopped before a restore swaps the database');
  assert.equal((read('modules/backup.js').match(/haDiscoveryService'\)\.start\(\)/g) || []).length, 2, 'started again after a restore or a rollback');
  assert.match(read('modules/encryption.js'), /ha_discovery: \['password'\]/, 'the broker password is stored encrypted');
  assert.match(read('modules/protectedConfig.js'), /\^ha_discovery/, '/api/settings cannot write it');
  assert.match(read('public/settings.html'), /id="section-homeassistant"/);
  assert.doesNotMatch(read('public/js/ha-discovery-settings.js'), /innerHTML\s*=/, 'drawn with textContent');
  console.log('ok - home assistant discovery');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
