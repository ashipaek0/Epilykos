'use strict';
/**
 * Checks on source settings before they are saved.
 *
 * @module sourceChecks
 */

/**
 * Two inverters on the same profile with the same metric prefix write the
 * same metric names (pv_power, battery_soc, ...), so each overwrites the
 * other's readings and there is nothing left to combine. Returns a sentence
 * explaining the clash, or null. Devices with their own metric mappings are
 * left alone: their names come from the mapping.
 */
function dongleNameClash(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const seen = new Map();
  for (const d of list) {
    if (!d || d.enabled === false || !d.profile) continue;
    if (d.mappings && typeof d.mappings === 'object' && Object.keys(d.mappings).length) continue;
    const key = `${d.profile}\u0000${String(d.prefix || '').trim().toLowerCase()}`;
    const other = seen.get(key);
    if (other) {
      const name = x => (x.name && String(x.name).trim()) || 'An inverter';
      return `"${name(other)}" and "${name(d)}" use the same profile${d.prefix ? ` and the prefix "${d.prefix}"` : ' with no metric prefix'}, so their readings would overwrite each other. Give each its own metric prefix, for example inv1_ and inv2_, then add them up in Metrics > Combined metrics.`;
    }
    seen.set(key, d);
  }
  return null;
}

module.exports = { dongleNameClash };
