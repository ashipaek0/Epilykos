'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const tls = require('tls');
const { LuxpowerTcpTransport, derivePsk, crc16Modbus } = require('../modules/dongle/luxpowerTcp');
const config = { host: '127.0.0.1', dongle_serial: 'DT00000001', inverter_serial: 'IN00000001', timeout_ms: 700 };
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
function reply(req) {
  const b = Buffer.alloc(39); req.copy(b, 0, 0, 34); b.writeUInt16LE(33, 4); b.writeUInt16LE(19, 18); b[20] = 1; b[34] = 2; b.writeUInt16LE(42, 35); b.writeUInt16LE(crc16Modbus(b.subarray(20, 37)), 37); return b;
}
test('PSK derivation uses exact serial and known app literal', () => {
  assert.equal(derivePsk('DT00000001').toString('hex'), '842210b69cc5b81c5f455b2c5f6b23cd');
  assert.notDeepEqual(derivePsk('dt00000001'), derivePsk('DT00000001'));
  assert.throws(() => new LuxpowerTcpTransport({ ...config, tls_policy: 'bogus' }), /TLS/);
});
test('TLS-required connects with PSK and sends translated reads only after handshake', async () => {
  let identity;
  const server = tls.createServer({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'DHE-PSK-AES128-GCM-SHA256', dhparam: 'auto', pskCallback: (_s, id) => { identity = id; return derivePsk(config.dongle_serial); } }, s => s.on('data', b => s.write(reply(b))));
  const t = new LuxpowerTcpTransport({ ...config, port: await listen(server), tls_policy: 'required' });
  try { assert.equal((await t.readRegisters(0, 1)).readUInt16LE(), 42); assert.equal(identity, 'Client_identity'); assert.equal(t.diagnostics.mode, 'tls-psk'); }
  finally { t.stop(); await new Promise(r => server.close(r)); }
});
test('auto fallback opens a fresh socket; required refuses legacy server without sending a write', async () => {
  let connections = 0, writes = 0;
  const sockets = new Set();
  const server = net.createServer(s => { connections++; sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); s.on('data', b => { if (b[0] !== 0xa1) { s.destroy(); return; } if (b[21] === 6) writes++; s.write(reply(b)); }); });
  const port = await listen(server);
  const t = new LuxpowerTcpTransport({ ...config, port, tls_policy: 'auto' });
  const required = new LuxpowerTcpTransport({ ...config, port, tls_policy: 'required' });
  try {
    assert.equal((await t.readRegisters(0, 1)).readUInt16LE(), 42); assert.equal(connections, 2); assert.equal(t.diagnostics.mode, 'plain-fallback'); assert.ok(t.diagnostics.tlsFailure);
    await assert.rejects(required.writeRegister(64, 50)); assert.equal(writes, 0);
  } finally { t.stop(); required.stop(); for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); }
});
test('stop during TLS negotiation rejects queued work and does not fallback', async () => {
  const sockets = new Set(); let connections = 0;
  const server = net.createServer(s => { connections++; sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const t = new LuxpowerTcpTransport({ ...config, port: await listen(server), tls_policy: 'auto' });
  try {
    const pending = t.readRegisters(0, 1); const rejected = assert.rejects(pending, /stopped/);
    await new Promise(r => setTimeout(r, 30)); t.stop(); await rejected;
    await new Promise(r => setTimeout(r, 30)); assert.equal(connections, 1);
  } finally { t.stop(); for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); }
});
test('auto never falls back or replays a write after TLS was established', async () => {
  let connections = 0, writes = 0;
  const server = tls.createServer({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'DHE-PSK-AES128-GCM-SHA256', dhparam: 'auto', pskCallback: () => derivePsk(config.dongle_serial) }, s => { connections++; s.on('data', b => { if (b[21] === 6) writes++; s.destroy(); }); });
  const t = new LuxpowerTcpTransport({ ...config, port: await listen(server), tls_policy: 'auto' });
  try { await assert.rejects(t.writeRegister(64, 49), /closed|reset/i); assert.equal(writes, 1); assert.equal(connections, 1); assert.equal(t.diagnostics.mode, 'tls-psk'); }
  finally { t.stop(); await new Promise(r => server.close(r)); }
});
