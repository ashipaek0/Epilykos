'use strict';
// Deleting metrics from Settings > Metrics, one or several at once.
// A combined metric is refused (it is written again every cycle while its
// definition exists). Roles pointing at a deleted metric are cleared, and the
// combined metrics that still add it up are named so the person can change them.
const { getConfig, setConfig } = require('./database');
const { deleteMetric } = require('./metricsManager');
const combinedMetrics = require('./combinedMetrics');

const MAX_AT_ONCE = 500;

/**
 * @param {string[]} names
 * @returns {{ deleted: string[], blocked: {name: string, reason: string}[],
 *   rolesCleared: string[], usedBy: Object<string, string[]> }}
 *   rolesCleared: the roles left unmapped; usedBy: deleted metric -> combined metrics that use it
 */
function deleteMetrics(names) {
  const unique = [...new Set((Array.isArray(names) ? names : []).map(n => String(n).trim()).filter(Boolean))];
  if (unique.length > MAX_AT_ONCE) throw new RangeError(`At most ${MAX_AT_ONCE} metrics can be deleted at once.`);
  const combined = new Set(combinedMetrics.loadDefinitions().filter(Boolean).map(d => String(d.name).trim()));
  const deleted = [], blocked = [];
  for (const name of unique) {
    if (combined.has(name)) {
      blocked.push({ name, reason: `${name} is a combined metric. Delete it under Combined metrics, or it is worked out again on the next reading.` });
      continue;
    }
    deleteMetric(name);
    deleted.push(name);
  }
  // Roles pointing at a deleted metric would point at nothing: clear them.
  let rolesCleared = [];
  if (deleted.length) {
    try {
      const roles = JSON.parse(getConfig('role_metrics') || '{}') || {};
      rolesCleared = Object.keys(roles).filter(r => deleted.includes(roles[r]));
      if (rolesCleared.length) { rolesCleared.forEach(r => { roles[r] = ''; }); setConfig('role_metrics', JSON.stringify(roles)); }
    } catch (_) { /* roles unreadable: nothing to clear */ }
  }
  const usedBy = {};
  for (const def of combinedMetrics.loadDefinitions()) {
    if (!def) continue;
    for (const input of (def.inputs || []).map(x => String(x).trim())) {
      if (deleted.includes(input)) (usedBy[input] = usedBy[input] || []).push(def.name);
    }
  }
  return { deleted, blocked, rolesCleared, usedBy };
}

module.exports = { deleteMetrics, MAX_AT_ONCE };
