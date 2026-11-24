'use strict';
/**
 * modules/automations/catalog.js — what an automation may change.
 *
 * The catalog is built from the configured devices each time it is asked
 * for, so a new Tuya plug, Home Assistant entity, MQTT topic or inverter /
 * battery setting appears in it as soon as it is configured. Only the same
 * things the Controls page lists are offered: switches, numbers and
 * selectors. Raw register writes are never in the catalog.
 *
 * Entry: { key, source, device, entity, label, group, kind, ops, metric, deviceKind?,
 *          min?, max?, step?, unit?, options?, haDomain?, setAction? }
 *   kind  'switch' (on/off), 'number', 'select', or 'value' (free value: Tuya, MQTT, HA)
 *   ops   'on' | 'off' | 'set' — what a step may do to it
 */
const switchables = require('../switchables');

const keyOf = (source, device, entity) => `${source}|${device}|${entity}`;

function buildCatalog() {
  const out = [];
  for (const e of switchables.switchableEntities()) {
    if (e.source === 'device') continue;
    const ops = [];
    if (e.action) ops.push('on', 'off');
    if (e.selectAction || e.setAction) ops.push('set');
    if (!ops.length) continue;
    out.push({ key: keyOf(e.source, e.device, e.entity), source: e.source, device: e.device, entity: e.entity, label: e.label, group: e.group,
      kind: e.action && !(e.selectAction || e.setAction) ? 'switch' : (e.source === 'ha' && e.setAction && !e.action && !e.selectAction ? 'number' : 'value'),
      ops, metric: e.metric || '', haDomain: e.source === 'ha' ? String(e.entity || '').split('.')[0] : '',
      selectAction: e.selectAction || null, setAction: e.setAction || null });
  }
  let devices = [];
  try { devices = require('../deviceControls').listDevices(); } catch (_) { devices = []; }
  for (const d of devices) {
    for (const s of d.settings || []) {
      if (!['switch', 'number', 'select'].includes(s.type)) continue;   // times of day are not offered
      const entry = { key: keyOf('device', d.name, s.name), source: 'device', device: d.name, entity: s.name, label: s.label || s.name,
        group: `Inverter and battery · ${d.name}`, kind: s.type, metric: '', deviceKind: d.kind, unit: s.unit || '', ops: s.type === 'switch' ? ['on', 'off'] : ['set'] };
      if (s.type === 'number') Object.assign(entry, { min: s.min, max: s.max, step: s.step });
      if (s.type === 'select') {
        const labels = s.labels || {};
        entry.options = (Array.isArray(s.allowed) ? s.allowed : Object.keys(labels)).map(v => ({ value: String(v), label: String(labels[v] != null ? labels[v] : v) }));
      }
      out.push(entry);
    }
  }
  return out;
}

function findTarget(catalog, t) {
  if (!t || typeof t !== 'object') return null;
  const key = keyOf(t.source, t.device, t.entity);
  return catalog.find(c => c.key === key) || null;
}

module.exports = { buildCatalog, findTarget, keyOf };
