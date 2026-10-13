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
// What each HA domain can be: a toggle (on/off) and/or a selector (pick a value).
const HA_TOGGLE = { switch: 'switch.toggle', light: 'light.toggle', fan: 'fan.toggle', input_boolean: 'input_boolean.toggle' };
const HA_SELECT = { select: 'select.select_option', input_select: 'input_select.select_option', climate: 'climate.set_hvac_mode', fan: 'fan.set_preset_mode' };
const HA_SWITCH_DOMAINS = Object.keys(HA_TOGGLE);

/**
 * [{ source, device, entity, metric, group, label, action, selectAction }]
 * `action` is the toggle action (null when it can't toggle), `selectAction`
 * the one a state selector uses (null when it has no values to pick).
 */
function switchableEntities() {
  const list = (key) => { try { const v = JSON.parse(getConfig(key) || '[]'); return Array.isArray(v) ? v.filter(Boolean) : []; } catch (_) { return []; } };
  const out = [];
  for (const d of list('tuya_devices')) {
    if (!d.enabled) continue;
    const device = d.name || d.dev_id;
    for (const [metric, dp] of Object.entries(d.dps || {})) {
      // A DP can be a switch or an enum (mode); both send its new value.
      out.push({ source: 'tuya', device, entity: metric, metric, action: 'switch.toggle', selectAction: 'set', group: `Tuya · ${device}`, label: `${metric} (DP ${dp})` });
    }
  }
  for (const d of list('ha_devices')) {
    if (!d.enabled) continue;
    for (const [metric, m] of Object.entries(d.entities || {})) {
      const entityId = (m && typeof m === 'object') ? m.entityId : m;
      const domain = String(entityId || '').split('.')[0];
      const action = HA_TOGGLE[domain] || null, selectAction = HA_SELECT[domain] || null;
      if (!action && !selectAction) continue;
      out.push({ source: 'ha', device: d.name, entity: entityId, metric, action, selectAction, group: `Home Assistant · ${d.name}`, label: `${metric} (${entityId})` });
    }
  }
  for (const d of list('mqtt_devices')) {
    if (!d.enabled || !d.broker) continue;
    for (const [metric, topic] of Object.entries(d.topics || {})) {
      if (!topic) continue;
      out.push({ source: 'mqtt', device: d.broker, entity: topic, metric, action: 'toggle', selectAction: 'set', group: `MQTT · ${d.name || d.broker}`, label: `${metric} (${topic})` });
    }
  }
  return out;
}

module.exports = { switchableEntities, HA_SWITCH_DOMAINS, HA_TOGGLE, HA_SELECT };
