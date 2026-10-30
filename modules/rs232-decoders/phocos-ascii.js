'use strict';
/**
 * Phocos Any-Grid PSW-H, RS-232 / RS-485 ASCII query protocol (protocol
 * "phocos-ascii", 2400 baud 8N1).
 *
 * A request is the command text, a two-byte CRC, then CR:  "QPGS0" 3F DA 0D.
 * A reply is "(" + space-separated fields + two CRC bytes + CR. The CRC is
 * CRC-16/XMODEM over everything before it, high byte first. The ten example
 * CRCs in Phocos's command document (QPGS0..QPGS9) all match this function.
 *
 * Voltronic-family units avoid the bytes ( CR LF in a CRC by adding one to
 * them. The document's CRC chapter is not available to confirm that Phocos
 * does the same, so a reply is accepted when its CRC matches either way.
 *
 * Fields are split and mapped by modules/rs232.js, like the other ASCII
 * profiles; this module only frames and checks.
 *
 * @module rs232-decoders/phocos-ascii
 */

const CR = 0x0d;
const AVOID = new Set([0x28, 0x0d, 0x0a]);

/** CRC-16/XMODEM (poly 0x1021, init 0, no reflection). */
function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const adjust = byte => (AVOID.has(byte) ? byte + 1 : byte);

/** The CRC bytes a unit may send for `body`: the plain ones and the adjusted ones. */
function crcCandidates(body) {
  const crc = crc16(body), hi = crc >> 8, lo = crc & 0xff;
  return [[hi, lo], [adjust(hi), adjust(lo)]];
}

/** The request for a command: text + CRC + CR (sent with the adjusted CRC, as Voltronic-family units expect). */
function encodeQuery(cmd) {
  const text = Buffer.from(String(cmd && cmd.query || '').replace(/[\r\n]+$/, ''), 'ascii');
  if (!text.length) return Buffer.alloc(0);
  const [, [hi, lo]] = crcCandidates(text);
  return Buffer.concat([text, Buffer.from([hi, lo, CR])]);
}

/** Is `buffer` one whole reply with a CRC that checks out? */
function isCompleteFrame(buffer) {
  if (!buffer || buffer.length < 5 || buffer[0] !== 0x28 || buffer[buffer.length - 1] !== CR) return false;
  const body = buffer.subarray(0, buffer.length - 3), got = [buffer[buffer.length - 3], buffer[buffer.length - 2]];
  return crcCandidates(body).some(([hi, lo]) => hi === got[0] && lo === got[1]);
}

/**
 * The reply's text after "(" with the CRC and CR removed. Throws when the
 * reply is not whole or its CRC does not match, so a damaged line is never read as data.
 */
function unwrap(buffer) {
  if (!isCompleteFrame(buffer)) throw new Error('Phocos reply is incomplete or its CRC does not match');
  return buffer.subarray(1, buffer.length - 3).toString('ascii');
}

/** A reply built the way a unit sends it, for tests and simulators. */
function frameReply(text) {
  const body = Buffer.from('(' + text, 'ascii');
  const [, [hi, lo]] = crcCandidates(body);
  return Buffer.concat([body, Buffer.from([hi, lo, CR])]);
}

module.exports = { crc16, encodeQuery, isCompleteFrame, unwrap, frameReply, crcCandidates };
