'use strict';
const { identityFromHolding, currentDivisor } = require('./luxpowerModel');

const queues = new Map();
function serialized(key, operation) {
  const prior = queues.get(key) || Promise.resolve();
  const result = prior.then(operation, operation);
  const tail = result.catch(() => {});
  queues.set(key, tail);
  return result.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
}
// Which inverters a named control is for. 'geta' (the default) needs the
// LuxCloud single-phase/type13 GETA identity. 'luxpower' needs any inverter
// identity: the LuxPower protocol document and the Home Assistant integration
// it comes from give those settings for every model, not per model.
const familyOf = w => w.family || 'geta';
function familyRefusal(w, model) {
  if (familyOf(w) === 'luxpower') return model ? null : 'Could not read the inverter identity';
  return model && model.geta ? null : 'Detected device is not single-phase GETA (type13)';
}
// A setting can be a field inside its register (mask); the rest of the word is kept.
const fieldMask = w => (w.mask === undefined ? 0xFFFF : w.mask);
const shiftOf = mask => { let n = 0; while (n < 15 && !((mask >> n) & 1)) n++; return n; };
function descriptor(w) {
  const choices = w.kind === 'enum' ? { allowed: Object.keys(w.options).map(Number), labels: w.options } : {};
  return { ...w, ...choices, type: w.kind === 'bitfield' ? 'switch' : w.kind === 'time' ? 'time' : w.kind === 'enum' ? 'select' : 'number',
    writable: false, blockedReason: `Read the device to check ${familyOf(w) === 'geta' ? 'GETA' : 'its'} identity and the current value` };
}
function decode(w, raw) {
  if (w.kind === 'bitfield') return !!(raw & w.mask);
  if (w.kind === 'time') return `${String(raw & 255).padStart(2, '0')}:${String(raw >> 8).padStart(2, '0')}`;
  const field = (raw & fieldMask(w)) >> shiftOf(fieldMask(w));
  return w.kind === 'enum' ? field : field * (w.scale || 1);
}
function encode(w, value) {
  if (w.kind === 'bitfield') {
    if (typeof value !== 'boolean') throw new Error('Choose On or Off');
    return value ? w.mask : 0;
  }
  if (w.kind === 'time') {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Use HH:MM from 00:00 to 23:59');
    const [h, m] = value.split(':').map(Number); return h | (m << 8);
  }
  let field;
  if (w.kind === 'enum') {
    if (!Number.isInteger(value) || !Object.prototype.hasOwnProperty.call(w.options, String(value))) throw new Error(`Choose one of: ${Object.values(w.options).join(', ')}`);
    field = value;
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < w.min || value > w.max || Math.abs((value - w.min) / w.step - Math.round((value - w.min) / w.step)) > 1e-6) throw new Error(`Must be between ${w.min} and ${w.max}, in steps of ${w.step}`);
    field = Math.round(value / (w.scale || 1));
  }
  const bits = field << shiftOf(fieldMask(w));
  if (bits < 0 || (bits & ~fieldMask(w))) throw new Error('Does not fit the register');
  return bits;
}
function inRange(w, raw) {
  try { return encode(w, decode(w, raw)) === (raw & fieldMask(w)); }
  catch { return false; }
}
async function word(t, address) {
  const b = await t.readRegisters(address, 1, 3);
  if (!Buffer.isBuffer(b) || b.length !== 2) throw new Error('Short setting response');
  return b.readUInt16LE();
}
async function read(t, w) {
  const id = identityFromHolding(await t.readRegisters(0, 40, 3));
  const raw = await word(t, Number(w.register));
  const valid = inRange(w, raw);
  const blockedReason = familyRefusal(w, id.model) || (!valid ? 'The current value is outside the supported format/range' : null);
  return { value: decode(w, raw), raw, inRange: valid, writable: !blockedReason, blockedReason,
    identity: id, hardwareValidated: false, evidence: w.evidence };
}
async function change(t, w, expected, value, mayWrite = () => true) {
  if (expected === undefined || expected === null) return { success: false, error: 'Read the current value and provide expected before changing it' };
  let target;
  try { target = encode(w, value); } catch (e) { return { success: false, error: e.message }; }
  const now = await read(t, w);
  if (!now.writable) return { success: false, error: now.blockedReason };
  if (typeof expected !== typeof now.value || expected !== now.value) return { success: false, error: 'It changed since you looked; read it again', current: now.value };
  if (value === now.value) return { success: true, value: now.value, unchanged: true };
  const raw = (now.raw & ~fieldMask(w) & 0xFFFF) | target;
  if (!mayWrite()) return { success: false, error: 'Changing device settings was turned off' };
  // Once submitted, an error is ambiguous. Never retry or report "not written".
  try { await t.writeRegister(Number(w.register), raw); }
  catch (e) { return { success: false, written: true, status: 'sent_unverified', error: `Write may have been sent: ${e.message}. Read before trying again.` }; }
  let back;
  try { back = await word(t, Number(w.register)); }
  catch (e) { return { success: false, written: true, status: 'sent_unverified', error: `Sent; readback failed: ${e.message}` }; }
  if (back !== raw) return { success: false, written: true, status: 'mismatch', value: decode(w, back), raw: back, error: 'Device readback did not match the full requested register word' };
  return { success: true, value: decode(w, back), status: 'verified', beforeRaw: now.raw, raw: back };
}
async function snapshot(t, profile, device) {
  const raw = { holding: {}, input: {} }, reads = [];
  const definitions = [...(profile.writable_registers || []), ...(profile.geta_controls || [])];
  const starts = [...new Set([0, ...definitions.map(w => Math.floor(Number(w.register) / 40) * 40)])].sort((a, b) => a - b);
  for (const [space, startsToRead, fn] of [['holding', starts, 3], ['input', [0, 80], 4]]) {
    for (const start of startsToRead) {
      const at = new Date().toISOString();
      try {
        const b = await t.readRegisters(start, 40, fn);
        if (!Buffer.isBuffer(b) || b.length !== 80) throw new Error('Short verification range');
        for (let i = 0; i < 40; i++) raw[space][start + i] = b.readUInt16LE(i * 2);
        reads.push({ space, start, count: 40, at, ok: true });
      } catch (e) { reads.push({ space, start, count: 40, at, ok: false, error: e.message }); }
    }
  }
  let identity = null;
  if (Array.from({ length: 40 }, (_, i) => i).every(i => raw.holding[i] !== undefined)) {
    const b = Buffer.alloc(80); for (let i = 0; i < 40; i++) b.writeUInt16LE(raw.holding[i], i * 2);
    identity = identityFromHolding(b);
  }
  const flags = raw.input[80], divisor = currentDivisor(identity && identity.model, flags);
  const valid = divisor && ((flags & 3) === 2 || flags === 0);
  return { schema: 1, device: device.name, profile: device.profile, capturedAt: new Date().toISOString(),
    serials: { dongle: device.dongle_serial || device.serial_number, inverter: device.inverter_serial || device.serial_number },
    identity, transport: t.diagnostics || {}, raw, reads, complete: reads.every(r => r.ok),
    decoded: { batterySoc: raw.input[5] === undefined ? null : raw.input[5] & 255, batteryFlags: flags ?? null,
      currentDivisor: divisor, bmsMaxChargeCurrent: valid && raw.input[81] !== undefined ? raw.input[81] / divisor : null,
      bmsMaxDischargeCurrent: valid && raw.input[82] !== undefined ? raw.input[82] / divisor : null },
    settings: definitions.map(w => { const v = raw.holding[Number(w.register)]; return { name: w.name, register: w.register, raw: v ?? null,
      value: v === undefined ? null : w.geta_control ? decode(w, v) : v * (w.scale || 1),
      inRange: v === undefined ? false : w.geta_control ? inRange(w, v) : v * (w.scale || 1) >= w.min && v * (w.scale || 1) <= w.max,
      hardwareValidated: false }; }),
    note: 'Read-only sequential snapshot, not an atomic sample or proof of hardware support. Compare each setting with LuxCloud and record device rating from its label. No writes or automatic restore performed.' };
}
module.exports = { serialized, descriptor, decode, encode, inRange, read, change, snapshot };
