#!/usr/bin/env node
'use strict';
// Offline only. Checks register persistence, never hardware semantics.
const fs = require('fs');
const path = require('path');
const { encode, inRange } = require('../modules/dongle/luxpowerSettings');
// The named controls of the profile the snapshots were taken with.
function profileOf(before, after) {
  const id = String(before.profile || 'luxpower-geta');
  if (!/^luxpower-[a-z0-9-]+$/.test(id)) throw new Error(`Not a LuxPower profile: ${id}`);
  if (after.profile && after.profile !== id) throw new Error('The snapshots were taken with different profiles');
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'dongles', `${id}.json`), 'utf8'));
}
function compare(before, after, settingName, expectedText) {
  const setting = (profileOf(before, after).geta_controls || []).find(w => w.name === settingName);
  if (!setting) throw new Error('Unknown named control');
  if (!before.complete || !after.complete) throw new Error('Both snapshots must have complete reads');
  if (!before.identity?.model || !after.identity?.model) throw new Error('Both snapshots must include the inverter identity');
  if ((setting.family || 'geta') === 'geta' && (!before.identity.model.geta || !after.identity.model.geta)) throw new Error('Both snapshots must identify GETA');
  const stable = x => [x.identity.model.rawWord, x.identity.modelRaw, x.identity.standard, x.identity.communicationVersion, x.identity.slaveVersion, x.identity.firmwareVersion];
  if (!before.serials?.dongle || !before.serials?.inverter || before.serials.dongle !== after.serials?.dongle || before.serials.inverter !== after.serials?.inverter || JSON.stringify(stable(before)) !== JSON.stringify(stable(after))) throw new Error('Device identity changed; compare snapshots from the same inverter/firmware');
  const expected = setting.kind === 'bitfield' ? expectedText === 'true' ? true : expectedText === 'false' ? false : null : setting.kind === 'time' ? expectedText : expectedText.trim() === '' ? NaN : Number(expectedText);
  const target = encode(setting, expected), address = Number(setting.register);
  const old = before.raw?.holding?.[address], value = after.raw?.holding?.[address];
  if (!Number.isInteger(old) || !Number.isInteger(value) || !inRange(setting, old) || !inRange(setting, value)) throw new Error('Invalid or absent current register');
  // Bits outside the setting's field (other flags, the other byte, other selectors) must be kept.
  const field = setting.mask === undefined ? 0xFFFF : setting.mask;
  const wanted = (old & ~field & 0xFFFF) | target;
  const otherHoldingChanges = Object.keys(before.raw.holding).filter(k => Number(k) !== address && after.raw.holding[k] !== undefined && before.raw.holding[k] !== after.raw.holding[k]).map(k => ({ register: Number(k), before: before.raw.holding[k], after: after.raw.holding[k] }));
  return { setting: settingName, register: address, beforeRaw: old, expectedRaw: wanted, afterRaw: value, matched: value === wanted,
    otherHoldingChanges, hardwareValidated: false, note: 'Persistence/bit-preservation check only. Independently confirm LuxCloud and physical behavior.' };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 6) throw new Error('Usage: node scripts/verify-luxpower-snapshots.js before.json after.json setting expected-value');
    const r = compare(JSON.parse(fs.readFileSync(process.argv[2])), JSON.parse(fs.readFileSync(process.argv[3])), process.argv[4], process.argv[5]);
    console.log(JSON.stringify(r, null, 2)); if (!r.matched) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { compare };
