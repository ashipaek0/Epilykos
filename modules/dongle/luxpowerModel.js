'use strict';

// LuxCloud 5.0.0 Inverter.isGeta / isBatCurrUnit10 and holding0/count40.
// These predicates identify the app family, not a verified power rating.
function modelFromWord(word) {
  if (!Number.isInteger(word) || word < 0 || word > 65535) return null;
  const phase = (word & 1) ? 3 : 1;
  const deviceType = (word >> 1) & 15;
  return { rawWord: word, phase, deviceType, dtc: (word >> 5) & 7,
    voltageClass: (word >> 8) & 1, geta: phase === 1 && deviceType === 13 };
}

function currentDivisor(model, flags) {
  if (!model || !Number.isInteger(flags)) return null;
  if (model.deviceType === 2 || (model.phase === 3 && model.deviceType === 0)) return 100;
  if ([6, 7, 8].includes(model.deviceType)) return 10;
  return flags & 1024 ? 10 : 100;
}

function identityFromHolding(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 40) throw new Error('Short holding identity response');
  const words = Array.from({ length: Math.floor(buffer.length / 2) }, (_, i) => buffer.readUInt16LE(i * 2));
  return { model: modelFromWord(words[19]), modelRaw: words[0] + words[1] * 65536,
    standard: buffer.subarray(14, 18).toString('ascii').replace(/\0/g, ''),
    communicationVersion: words[9] & 255, slaveVersion: words[9] >> 8,
    firmwareVersion: words[10] & 255, rawWords: words,
    evidence: 'LuxCloud 5.0.0 static code', hardwareValidated: false };
}

// Connection Test must not turn a working legacy telemetry read into failure
// solely because optional identity discovery is unavailable on that firmware.
async function identityDiagnostic(transport) {
  try { return { identity: identityFromHolding(await transport.readRegisters(0, 40, 3)), identityError: null }; }
  catch (e) { return { identity: null, identityError: e.message }; }
}

module.exports = { modelFromWord, currentDivisor, identityFromHolding, identityDiagnostic };
