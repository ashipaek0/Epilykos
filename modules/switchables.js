'use strict';
const { getConfig } = require('./database');

/**
 * modules/switchables.js — everything a toggle card can switch, from the
 * configured sources, with the
 * identifiers each /api/action branch expects: Tuya and HA resolve by device
 * name, MQTT by broker and topic. `metric` is what the card reads its state
 * from. Listed whether or not the metric has a reading yet, so a switch can
 * be placed before its first poll. Device settings (source 'device') come last.
 */
// What each HA domain can be: a toggle (on/off) and/or a selector (pick a value).
const HA_TOGGLE = { switch: 'switch.toggle', light: 'light.toggle', fan: 'fan.toggle', input_boolean: 'input_boolean.toggle' };
const HA_SELECT = { select: 'select.select_option', input_select: 'input_select.select_option', climate: 'climate.set_hvac_mode', fan: 'fan.set_preset_mode' };
// One-shot: buttons are pressed, scenes and scripts are run.
const HA_PRESS = { button: 'button.press', input_button: 'input_button.press', scene: 'scene.turn_on', script: 'script.turn_on' };
// A number to set (slider and knob cards). Only entities whose state IS the value: a light's brightness is
// an attribute, which the card could not show back.
const HA_SET = { number: 'number.set_value', input_number: 'input_number.set_value' };
const HA_SWITCH_DOMAINS = Object.keys(HA_TOGGLE);

/**
 * [{ source, device, entity, metric, group, label, action, selectAction, pressAction, setAction }]
 * `action` is the toggle action (null when it can't toggle), `selectAction`
 * the one a state selector uses (null when it has no values to pick),
 * `pressAction` a one-shot press for button cards (HA buttons, scenes, scripts),
 * `setAction` the one a slider or knob uses to send a number (null when it takes none).
 */
function switchableEntities() {
  const list = (key) => { try { const v = JSON.parse(getConfig(key) || '[]'); return Array.isArray(v) ? v.filter(Boolean) : []; } catch (_) { return []; } };
  const out = [];
  for (const d of list('tuya_devices')) {
    if (!d.enabled) continue;
    const device = d.name || d.dev_id;
    for (const [metric, dp] of Object.entries(d.dps || {})) {
      // A DP can be a switch or an enum (mode); both send its new value.
      out.push({ source: 'tuya', device, entity: metric, metric, action: 'switch.toggle', selectAction: 'set', setAction: 'set', group: `Tuya · ${device}`, label: `${metric} (DP ${dp})` });
    }
  }
  for (const d of list('ha_devices')) {
    if (!d.enabled) continue;
    for (const [metric, m] of Object.entries(d.entities || {})) {
      const entityId = (m && typeof m === 'object') ? m.entityId : m;
      const domain = String(entityId || '').split('.')[0];
      const action = HA_TOGGLE[domain] || null, selectAction = HA_SELECT[domain] || null, pressAction = HA_PRESS[domain] || null, setAction = HA_SET[domain] || null;
      if (!action && !selectAction && !pressAction && !setAction) continue;
      out.push({ source: 'ha', device: d.name, entity: entityId, metric, action, selectAction, pressAction, setAction, group: `Home Assistant · ${d.name}`, label: `${metric} (${entityId})` });
    }
  }
  for (const d of list('mqtt_devices')) {
    if (!d.enabled || !d.broker) continue;
    for (const [metric, topic] of Object.entries(d.topics || {})) {
      if (!topic) continue;
      out.push({ source: 'mqtt', device: d.broker, entity: topic, metric, action: 'toggle', selectAction: 'set', setAction: 'set', group: `MQTT · ${d.name || d.broker}`, label: `${metric} (${topic})` });
    }
  }
  out.push(...deviceSettingEntities());
  return out;
}

/**
 * Inverter and battery settings (the Controls page's own list: LuxPower and
 * Phocos dongles, JBD and JK batteries), so the control cards can use them.
 * They are not read from a polled metric and are not sent through /api/action:
 * the cards read and change them live through /api/controls/read and /change,
 * which keep every safety rule (read first, expected value, read-back, change
 * log, "Device changes", unlock). `deviceKind` says which cards can use one:
 * switch (toggle), select (state select) or number (slider and knob).
 */
function deviceSettingEntities() {
  let devices = [];
  try { devices = require('./deviceControls').listDevices(); } catch (_) { return []; }
  const out = [];
  for (const d of devices) {
    for (const s of d.settings || []) {
      const deviceKind = s.type === 'switch' ? 'switch' : s.type === 'select' ? 'select' : s.type === 'number' ? 'number' : null;
      if (!deviceKind) continue;   // times of day have no control card
      const entry = { source: 'device', device: d.name, entity: s.name, metric: '', deviceKind, action: null, selectAction: null, setAction: null,
        group: `Inverter and battery · ${d.name}`, label: s.label || s.name, unit: s.unit || '' };
      if (deviceKind === 'number') Object.assign(entry, { min: s.min, max: s.max, step: s.step });
      if (deviceKind === 'select') {
        const labels = s.labels || {};
        entry.options = (Array.isArray(s.allowed) ? s.allowed : Object.keys(labels)).map(v => ({ value: String(v), label: String(labels[v] != null ? labels[v] : v) }));
      }
      out.push(entry);
    }
  }
  return out;
}

module.exports = { switchableEntities, HA_SWITCH_DOMAINS, HA_TOGGLE, HA_SELECT, HA_PRESS, HA_SET };
