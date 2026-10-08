'use strict';
/**
 * A fake LuxPower GETA dongle on 127.0.0.1 for tests (and manual runs:
 * `node test/fixtures/fake-luxpower-dongle.js 8899`). Speaks the local TCP v5
 * TranslatedData frames: reads holding (0x03) / input (0x04) registers from
 * its own store as little-endian words, and write-single (0x06) updates the
 * store and echoes. Like the real dongle it serves one client: with
 * oneClient (the default) a second connection is closed, which is what made
 * writes on a separate connection fail with "connection closed" (issue #107).
 * Made-up serials and values only.
 */
const net = require('net');
const { crc16Modbus } = require('../../modules/dongle/luxpowerTcp');

const DONGLE = 'FAKE000001';
const INVERTER = 'FAKE000002';

function frame(inner, dongle) {
  const dataLen = inner.length + 2, frameLen = dataLen + 14;
  const f = Buffer.alloc(frameLen + 6);
  f[0] = 0xA1; f[1] = 0x1A; f.writeUInt16LE(5, 2); f.writeUInt16LE(frameLen, 4); f[6] = 0x01; f[7] = 0xC2;
  f.write(dongle, 8, 10, 'ascii'); f.writeUInt16LE(dataLen, 18); inner.copy(f, 20); f.writeUInt16LE(crc16Modbus(inner), frameLen + 4);
  return f;
}
function readReply(devFn, start, words, inverter, dongle) {
  const inner = Buffer.alloc(15 + words.length * 2);
  inner[0] = 0x01; inner[1] = devFn; inner.write(inverter, 2, 10, 'ascii'); inner.writeUInt16LE(start, 12); inner[14] = words.length * 2;
  words.forEach((w, i) => inner.writeUInt16LE(w & 0xFFFF, 15 + i * 2));
  return frame(inner, dongle);
}
function writeEcho(start, value, inverter, dongle) {
  const inner = Buffer.alloc(16);
  inner[0] = 0x01; inner[1] = 0x06; inner.write(inverter, 2, 10, 'ascii'); inner.writeUInt16LE(start, 12); inner.writeUInt16LE(value, 14);
  return frame(inner, dongle);
}

/**
 * @param {object} [opts] { holding: {reg: value}, input: {reg: value}, oneClient = true,
 *   refuse: Set of holding registers whose writes are ignored (echoed, value kept), limit: {reg: max} }
 */
function startFakeDongle(opts = {}) {
  const holding = new Map(Object.entries(opts.holding || {}).map(([k, v]) => [Number(k), v]));
  const input = new Map(Object.entries(opts.input || {}).map(([k, v]) => [Number(k), v]));
  const oneClient = opts.oneClient !== false;
  const writes = [], connections = { opened: 0, refused: 0 };
  let active = null;
  const sockets = new Set();
  const server = net.createServer(sock => {
    connections.opened++;
    sockets.add(sock);
    sock.on('close', () => { sockets.delete(sock); if (active === sock) active = null; });
    sock.on('error', () => {});
    if (oneClient && active && !active.destroyed) { connections.refused++; sock.destroy(); return; }
    active = sock;
    let rx = Buffer.alloc(0);
    sock.on('data', chunk => {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length >= 38) {
        const req = rx.subarray(0, 38); rx = rx.subarray(38);
        const devFn = req[21], inverter = req.subarray(22, 32).toString('ascii'), dongle = req.subarray(8, 18).toString('ascii');
        const start = req.readUInt16LE(32), countOrValue = req.readUInt16LE(34);
        if (devFn === 0x06) {
          let value = countOrValue;
          if (opts.limit && opts.limit[start] !== undefined) value = Math.min(value, opts.limit[start]);
          writes.push({ register: start, value: countOrValue });
          if (!(opts.refuse && opts.refuse.has(start))) holding.set(start, value);
          sock.write(writeEcho(start, countOrValue, inverter, dongle));
        } else {
          const store = devFn === 0x04 ? input : holding;
          const words = Array.from({ length: countOrValue }, (_, i) => store.get(start + i) || 0);
          sock.write(readReply(devFn, start, words, inverter, dongle));
        }
      }
    });
  });
  return new Promise(resolve => server.listen(opts.port || 0, '127.0.0.1', () => resolve({
    port: server.address().port, holding, input, writes, connections, dongleSerial: DONGLE, inverterSerial: INVERTER,
    close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); })
  })));
}

module.exports = { startFakeDongle, DONGLE, INVERTER };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8899;
  startFakeDongle({ port, holding: { 0x69: 20, 0x7D: 15, 0x4B: 90, 0xA0: 30, 0xA1: 90, 0xC4: 25, 0xC5: 85, 0xE3: 100 }, input: { 5: 64 } })
    .then(d => console.log(`fake LuxPower dongle on 127.0.0.1:${d.port} (dongle ${DONGLE}, inverter ${INVERTER})`));
}
