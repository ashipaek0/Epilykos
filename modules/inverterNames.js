/**
 * Repair inverter metric names the setup wizard saved without their prefix.
 *
 * An inverter with a prefix should name each reading prefix + the profile's
 * name for it (inv2_ + battery_soc = inv2_battery_soc). Two kinds of saved
 * names missed that, and only these are repaired:
 *   - the bare profile name (battery_soc), from an extra inverter whose names
 *     were not moved under its prefix;
 *   - the profile name after the prefix without its underscore
 *     (inv1battery_soc), from a prefix typed as "inv1" and changed later.
 * A name chosen by hand (anything else) is left as it is. The readings move
 * with the name (modules/metricRename), unless another source also writes
 * the old name, in which case only the inverter's setting changes.
 *
 * Runs on every start before the inverters are polled; once repaired there
 * is nothing left to do.
 *
 * @module inverterNames
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { getConfig, setConfig } = require('./database');
const { logger } = require('./logger');
const entityCatalog = require('./entityCatalog');
const { renameMetrics } = require('./metricRename');

const PROFILE_DIR = path.join(__dirname, '..', 'profiles', 'dongles');

function readList(key) {
  try { const v = JSON.parse(getConfig(key) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

/** handle -> profile name for a dongle profile, or null when it can't be read. */
function profileNames(profileId) {
  if (!profileId || !/^[a-z0-9._-]+$/i.test(profileId)) return null;
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, `${profileId}.json`), 'utf8'));
    return new Map(entityCatalog.dongleProfileEntities(profile).filter(e => e && e.name).map(e => [String(e.id), e.name]));
  } catch (_) {
    return null;
  }
}

/**
 * Work out the repair without changing anything.
 * @param {Array} dongles      dongle_config
 * @param {Set<string>} others metric names written by any other source
 * @param {(id: string) => Map|null} [namesFor]
 * @returns {{dongles: Array, renames: Array<[string,string]>, moveData: Set<string>}}
 */
function planRepair(dongles, others = new Set(), namesFor = profileNames) {
  const renames = [], moveData = new Set();
  const allKeys = new Set();
  for (const d of dongles) for (const k of Object.keys((d && d.mappings) || {})) allKeys.add(k);
  const out = dongles.map(d => {
    const prefix = String((d && d.prefix) || '').trim();
    if (!d || !prefix || !d.mappings || typeof d.mappings !== 'object') return d;
    const names = namesFor(d.profile);
    if (!names) return d;
    const loose = prefix.endsWith('_') ? prefix.slice(0, -1) : '';
    const mappings = {};
    let changed = false;
    for (const [key, handle] of Object.entries(d.mappings)) {
      const base = names.get(String(handle));
      const broken = base && key !== prefix + base && (key === base || (loose && key === loose + base));
      const target = broken ? prefix + base : key;
      if (broken && !allKeys.has(target) && !(target in mappings)) {
        mappings[target] = handle;
        renames.push([key, target]);
        // Another source writing the old name keeps its readings.
        if (!others.has(key) && dongles.filter(o => o && o.mappings && key in o.mappings).length === 1) moveData.add(key);
        changed = true;
      } else {
        mappings[key] = handle;
      }
    }
    return changed ? { ...d, mappings } : d;
  });
  return { dongles: out, renames, moveData };
}

/** Metric names the other sources' settings say they write. */
function otherSourceNames() {
  const names = new Set();
  for (const key of ['rs232_devices', 'modbus_devices', 'mqtt_devices', 'ha_devices', 'bms_devices', 'external_sources']) {
    for (const dev of readList(key)) {
      for (const k of Object.keys((dev && dev.mappings) || {})) names.add(k);
      for (const e of (dev && Array.isArray(dev.entities) ? dev.entities : [])) if (e && typeof e.name === 'string') names.add(e.name);
    }
  }
  return names;
}

function repairSavedNames() {
  const dongles = readList('dongle_config');
  if (!dongles.length) return null;
  const plan = planRepair(dongles, otherSourceNames());
  if (!plan.renames.length) return null;
  const started = Date.now();
  const result = renameMetrics(plan.renames, {
    moveData: plan.moveData,
    inTransaction: () => setConfig('dongle_config', JSON.stringify(plan.dongles))
  });
  logger.info(`Inverter metric names repaired: ${plan.renames.length} renamed under their inverter's prefix `
    + `(e.g. ${plan.renames[0][0]} -> ${plan.renames[0][1]}); ${result.rows} past readings moved; `
    + `settings updated: ${['dongle_config'].concat(result.settings).join(', ')} (${Date.now() - started} ms)`);
  return { renames: plan.renames, ...result };
}

module.exports = { planRepair, repairSavedNames, profileNames };
