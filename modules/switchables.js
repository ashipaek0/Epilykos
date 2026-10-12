'use strict';
const { getConfig } = require('./database');

/**
 * modules/switchables.js — everything a toggle card can switch, from the
 * configured sources, with the
 * identifiers each /api/action branch expects: Tuya and HA resolve by device
 * name, MQTT by broker and topic. `metric` is what the card reads its state
 * from. Listed whether or not the metric has a reading yet, so a switch can
 * be placed before its first poll.
 */
const HA_SWITCH_DOMAINS = ['switch', 'light', 'fan', 'input_boolean'];
function switchableEntities() {
  const list = (key) => { try { const v = JSON.parse(getConfig(key) || '[]'); return Array.isArray(v) ? v.filter(Boolean) : []; } catch (_) { return []; } };
  const out = [];
  for (const d of list('tuya_devices')) {
    if (!d.enabled) continue;
    const device = d.name || d.dev_id;
    for (const [metric, dp] of Object.entries(d.dps || {})) {
      out.push({ source: 'tuya', device, entity: metric, metric, action: 'switch.toggle', group: `Tuya · ${device}`, label: `${metric} (DP ${dp})` });
    }
  }
  for (const d of list('ha_devices')) {
    if (!d.enabled) continue;
    for (const [metric, m] of Object.entries(d.entities || {})) {
      const entityId = (m && typeof m === 'object') ? m.entityId : m;
      const domain = String(entityId || '').split('.')[0];
      if (!HA_SWITCH_DOMAINS.includes(domain)) continue;
      out.push({ source: 'ha', device: d.name, entity: entityId, metric, action: domain + '.toggle', group: `Home Assistant · ${d.name}`, label: `${metric} (${entityId})` });
    }
  }
  for (const d of list('mqtt_devices')) {
    if (!d.enabled || !d.broker) continue;
    for (const [metric, topic] of Object.entries(d.topics || {})) {
      if (!topic) continue;
      out.push({ source: 'mqtt', device: d.broker, entity: topic, metric, action: 'toggle', group: `MQTT · ${d.name || d.broker}`, label: `${metric} (${topic})` });
    }
  }
  return out;
}
module.exports = { switchableEntities, HA_SWITCH_DOMAINS };
