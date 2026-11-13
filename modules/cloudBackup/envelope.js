'use strict';
/**
 * The locked file format for off-box backups.
 *
 * The whole file (a verified gzip snapshot) is locked with a key made from the
 * user's passphrase, so a provider, or anyone who finds the copy, sees only
 * noise. It is written in numbered blocks, so a copy of any size is processed
 * in constant memory, an interrupted upload can resume from a block boundary,
 * and any change, reordering or cut-off is detected.
 *
 *   header (48 bytes)  magic "EPKCBK01" | log2 N | r | p | log2 block size |
 *                      salt (16) | nonce prefix (4) | check (16)
 *   blocks             each block is AES-256-GCM of up to 64 KiB, plus a
 *                      16-byte tag. The nonce is the prefix and the block
 *                      number. The header, the block number and a "last
 *                      block" flag are authenticated with every block.
 *
 * The check value tells a wrong passphrase apart from a damaged file before
 * any block is read. The passphrase is normalised (NFKC) so it types the same
 * on every device, and is never stored in the file or logged.
 *
 * @module cloudBackup/envelope
 */
const crypto = require('node:crypto');
const { Transform } = require('node:stream');

const MAGIC = Buffer.from('EPKCBK01', 'latin1');
const HEADER_BYTES = 48;
const BLOCK_LOG2 = 16;
const BLOCK_BYTES = 1 << BLOCK_LOG2;
const TAG_BYTES = 16;
const FRAME_BYTES = BLOCK_BYTES + TAG_BYTES;
const KDF = { logN: 15, r: 8, p: 1 };
const MIN_LENGTH = 8, MAX_LENGTH = 256;

function problem(message, code, status = 422) { return Object.assign(new Error(message), { code, status, cloudBackup: true }); }

function normalisePassphrase(passphrase) {
  if (typeof passphrase !== 'string') throw problem('Enter a passphrase.', 'PASSPHRASE_REQUIRED', 400);
  const text = passphrase.normalize('NFKC');
  if ([...text].length < MIN_LENGTH) throw problem(`The passphrase must have at least ${MIN_LENGTH} characters.`, 'PASSPHRASE_SHORT', 400);
  if ([...text].length > MAX_LENGTH) throw problem(`The passphrase can have at most ${MAX_LENGTH} characters.`, 'PASSPHRASE_LONG', 400);
  return text;
}

function derive(passphrase, salt, { logN, r, p }) {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 64, { N, r, p, maxmem: 256 * N * r }, (error, out) => error ? reject(error) : resolve(out));
  });
}
const checkOf = out => crypto.createHash('sha256').update('epilykos cloud backup check v1').update(out.subarray(32, 64)).digest().subarray(0, 16);

function blockNonce(prefix, index) {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}
function blockAad(header, index, last) {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index), 0);
  tail[8] = last ? 1 : 0;
  return Buffer.concat([header, tail]);
}

/** Sizes of a locked file for a given plain size, so a destination can be told the length in advance. */
function lockedSize(plainBytes) {
  const blocks = Math.max(1, Math.ceil(plainBytes / BLOCK_BYTES));
  return HEADER_BYTES + plainBytes + blocks * TAG_BYTES;
}

/** A transform that turns plain bytes into the locked file. Create one per upload. */
async function createLocker(passphrase, { salt = crypto.randomBytes(16), noncePrefix = crypto.randomBytes(4) } = {}) {
  const text = normalisePassphrase(passphrase);
  const out = await derive(text, salt, KDF);
  const key = out.subarray(0, 32);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[8] = KDF.logN; header[9] = KDF.r; header[10] = KDF.p; header[11] = BLOCK_LOG2;
  salt.copy(header, 12); noncePrefix.copy(header, 28); checkOf(out).copy(header, 32);

  let pending = Buffer.alloc(0), index = 0, wroteHeader = false;
  function seal(block, last) {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, blockNonce(noncePrefix, index), { authTagLength: TAG_BYTES });
    cipher.setAAD(blockAad(header, index, last));
    const body = Buffer.concat([cipher.update(block), cipher.final()]);
    index++;
    return Buffer.concat([body, cipher.getAuthTag()]);
  }
  return new Transform({
    transform(chunk, _, done) {
      try {
        const frames = [];
        if (!wroteHeader) { frames.push(header); wroteHeader = true; }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        // Always keep a full block back: the last block must be sealed as the last.
        while (pending.length > BLOCK_BYTES) {
          frames.push(seal(pending.subarray(0, BLOCK_BYTES), false));
          pending = pending.subarray(BLOCK_BYTES);
        }
        done(null, frames.length ? Buffer.concat(frames) : undefined);
      } catch (error) { done(error); }
    },
    flush(done) {
      try {
        const frames = [];
        if (!wroteHeader) { frames.push(header); wroteHeader = true; }
        frames.push(seal(pending, true));
        pending = Buffer.alloc(0);
        done(null, Buffer.concat(frames));
      } catch (error) { done(error); }
    }
  });
}

function readHeader(buffer) {
  if (buffer.length < HEADER_BYTES || !buffer.subarray(0, 8).equals(MAGIC)) throw problem('This is not an Epilykos off-box backup, or it is damaged.', 'NOT_A_BACKUP');
  const params = { logN: buffer[8], r: buffer[9], p: buffer[10] };
  if (buffer[11] !== BLOCK_LOG2 || params.logN < 14 || params.logN > 20 || params.r !== 8 || params.p !== 1) throw problem('This backup uses a format this version cannot read.', 'UNSUPPORTED');
  return { header: Buffer.from(buffer.subarray(0, HEADER_BYTES)), params, salt: buffer.subarray(12, 28), noncePrefix: buffer.subarray(28, 32), check: buffer.subarray(32, 48) };
}

/** Opens a locked file's header with the passphrase. Throws a plain message for a wrong passphrase. */
async function openHeader(passphrase, headerBytes) {
  const info = readHeader(headerBytes);
  const out = await derive(normalisePassphrase(passphrase), info.salt, info.params);
  if (!crypto.timingSafeEqual(checkOf(out), info.check)) throw problem('That passphrase does not open this backup.', 'WRONG_PASSPHRASE');
  return { ...info, key: out.subarray(0, 32) };
}

function openFrame(opened, index, frame, last) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', opened.key, blockNonce(opened.noncePrefix, index), { authTagLength: TAG_BYTES });
  decipher.setAAD(blockAad(opened.header, index, last));
  decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(frame.subarray(0, frame.length - TAG_BYTES)), decipher.final()]);
  } catch (_) {
    throw problem(`The backup is damaged or incomplete (block ${index + 1}).`, 'DAMAGED');
  }
}

/**
 * A quick check of a copy without reading all of it: the passphrase opens it and
 * its first block is intact. `bytes` holds at least its first block, and
 * `totalSize` is the whole file's length.
 */
async function checkStart(passphrase, bytes, totalSize) {
  const opened = await openHeader(passphrase, bytes);
  const body = totalSize - HEADER_BYTES;
  if (body < TAG_BYTES) throw problem('The backup is damaged or incomplete (it ends early).', 'DAMAGED');
  const last = body <= FRAME_BYTES;
  const frame = bytes.subarray(HEADER_BYTES, HEADER_BYTES + Math.min(body, FRAME_BYTES));
  if (frame.length < Math.min(body, FRAME_BYTES)) throw problem('The backup is damaged or incomplete.', 'DAMAGED');
  openFrame(opened, 0, frame, last);
  return { ok: true };
}

/** A transform that turns the locked file back into plain bytes. Verifies every block and that nothing is cut off. */
async function createUnlocker(passphrase) {
  let opened = null, head = Buffer.alloc(0), carry = Buffer.alloc(0), index = 0;
  function open(frame, last) {
    const plain = openFrame(opened, index, frame, last);
    index++;
    return plain;
  }
  return new Transform({
    async transform(chunk, _, done) {
      try {
        let data = chunk;
        if (!opened) {
          head = Buffer.concat([head, data]);
          if (head.length < HEADER_BYTES) return done();
          opened = await openHeader(passphrase, head.subarray(0, HEADER_BYTES));
          data = head.subarray(HEADER_BYTES); head = null;
        }
        carry = carry.length ? Buffer.concat([carry, data]) : data;
        const plains = [];
        // A full frame is only opened once more data follows it, so the last frame is known.
        while (carry.length > FRAME_BYTES) {
          plains.push(open(carry.subarray(0, FRAME_BYTES), false));
          carry = carry.subarray(FRAME_BYTES);
        }
        done(null, plains.length ? Buffer.concat(plains) : undefined);
      } catch (error) { done(error); }
    },
    flush(done) {
      try {
        if (!opened) throw problem('The backup is empty or incomplete.', 'DAMAGED');
        if (carry.length < TAG_BYTES) throw problem('The backup is damaged or incomplete (it ends early).', 'DAMAGED');
        done(null, open(carry, true));
      } catch (error) { done(error); }
    }
  });
}

module.exports = { createLocker, createUnlocker, checkStart, openHeader, readHeader, normalisePassphrase, lockedSize,
  HEADER_BYTES, BLOCK_BYTES, FRAME_BYTES, MIN_LENGTH, MAX_LENGTH };
