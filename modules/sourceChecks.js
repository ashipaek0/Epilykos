'use strict';
/**
 * Checks on source settings before they are saved.
 *
 * @module sourceChecks
 */

const fs = require('fs');
const path = require('path');

/** Metric names a dongle profile writes when the inverter has no mappings. */
function profileMetricNames(profileId) {
  if (!/^[a-z0-9_-]+$/i.test(String(profileId || ''))) return null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles', 'dongles', `${profileId}.json`), 'utf8'));
    const names = [...(p.fields || []), ...(p.metrics || [])].map(f => f && f.name).filter(Boolean);
    return names.length ? names : null;
  } catch (_) { return null; }
}

/**
 * Two inverters that write the same metric names overwrite each other's
 * readings every poll, and there is nothing left to combine. That happens with
 * the same profile and prefix, and also when one inverter is mapped to names
 * the other writes unmapped (the Load button maps to prefix + field name).
 * Compares the names each enabled inverter writes. Returns a sentence
 * explaining the clash, or null.
 */
function dongleNameClash(devices, namesOf = profileMetricNames) {
  const list = Array.isArray(devices) ? devices : [];
  const label = x => (x.name && String(x.name).trim()) || 'An inverter';
  const mapped = d => d.mappings && typeof d.mappings === 'object' && Object.keys(d.mappings).length > 0;
  const written = d => {
    const prefix = String(d.prefix || '').trim().toLowerCase();
    if (mapped(d)) return Object.keys(d.mappings).map(n => n.toLowerCase());
    const names = namesOf(d.profile);
    // Unknown profile: the same profile and prefix still clash.
    return names ? names.map(n => (prefix + n).toLowerCase()) : [`\u0000${d.profile}\u0000${prefix}`];
  };
  const owner = new Map();   // metric name -> device
  for (const d of list) {
    if (!d || d.enabled === false || !d.profile) continue;
    const shared = [];
    let other = null;
    for (const name of new Set(written(d))) {
      const o = owner.get(name);
      if (o) { other = other || o; if (o === other) shared.push(name); } else owner.set(name, d);
    }
    if (!other) continue;
    if (!mapped(d) && !mapped(other) && d.profile === other.profile) {
      return `"${label(other)}" and "${label(d)}" use the same profile${d.prefix ? ` and the prefix "${d.prefix}"` : ' with no metric prefix'}, so their readings would overwrite each other. Give each its own metric prefix, for example inv1_ and inv2_, then add them up in Metrics > Combined metrics.`;
    }
    const sample = shared.filter(n => !n.startsWith('\u0000')).slice(0, 3).join(', ');
    const fix = mapped(d) ? `Map "${label(d)}" to its own metric names` : `Give "${label(d)}" its own metric prefix (for example inv2_) and press Load to map it`;
    return `"${label(other)}" and "${label(d)}" would both write ${shared.length} of the same metrics${sample ? ` (${sample}${shared.length > 3 ? ', …' : ''})` : ''}, so their readings would overwrite each other. ${fix}, then add them up in Metrics > Combined metrics.`;
  }
  return null;
}

/**
 * Every bank metric is saved as bank_<output>, so two outputs with the same
 * name (in one bank or across banks) overwrite each other. Returns a sentence
 * naming the clash, or null.
 */
function bankOutputClash(banks) {
  const seen = new Map();
  for (const bank of Array.isArray(banks) ? banks : []) {
    if (!bank || bank.enabled === false) continue;
    for (const fn of Array.isArray(bank.functions) ? bank.functions : []) {
      const out = String(fn && fn.output || '').trim();
      if (!out) continue;
      const key = out.toLowerCase(), where = seen.get(key), name = String(bank.name || 'A battery bank').trim();
      if (where) return where === name
        ? `The battery bank "${name}" has two metrics called "${out}". Give each its own name.`
        : `The battery banks "${where}" and "${name}" both have a metric called "${out}", so one would overwrite the other (both save as bank_${out}). Rename one, for example ${out.replace(/^/, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_`)}.`;
      seen.set(key, name);
    }
  }
  return null;
}

module.exports = { dongleNameClash, bankOutputClash };
