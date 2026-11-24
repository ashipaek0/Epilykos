/**
 * Device actions: switch, select, press and register writes for Home
 * Assistant, MQTT, Tuya, Modbus, RS232 and dongle devices.
 *
 * `performAction` is the one place that dispatches an action. The HTTP route
 * (`POST /api/action`) calls it for a signed-in, unlocked person; automations
 * will call it with their own log source. It returns `{ status, body }` and
 * never touches `req`/`res`, so it can be tested without a server.
 */
const { logger } = require('./logger');
const deviceControls = require('./deviceControls');
const { getConfig } = require('./database');
const { getCurrentMetrics } = require('./metrics');

/**
 * Resolve the device an action targets. Dashboard switch/state-select cards
 * only store source + entity, so when `device` is empty it is looked up from
 * the configured device that maps the entity (HA entity_id, MQTT topic, Tuya
 * DP name). MQTT clients are keyed by broker URL, so an MQTT device name is
 * translated to its broker. Returns '' when nothing matches.
 */
function resolveActionDevice(source, device, entity) {
  const list = (key) => {
    try { const v = JSON.parse(getConfig(key) || '[]'); return Array.isArray(v) ? v.filter(Boolean) : []; } catch (_) { return []; }
  };
  const entityIdOf = (m) => (m && typeof m === 'object') ? m.entityId : m;
  if (source === 'mqtt') {
    const mqttDevices = list('mqtt_devices').filter(d => d.enabled && d.broker);
    const byRef = device ? mqttDevices.find(d => d.name === device || d.broker === device) : null;
    if (byRef) return byRef.broker;
    if (device) return device;
    const host = mqttDevices.find(d => Object.values(d.topics || {}).includes(entity));
    return host ? host.broker : '';
  }
  if (device || !entity) return device || '';
  if (source === 'ha') {
    const host = list('ha_devices').find(d => d.enabled &&
      Object.entries(d.entities || {}).some(([metric, m]) => entityIdOf(m) === entity || metric === entity));
    return host ? host.name : '';
  }
  if (source === 'tuya') {
    const host = list('tuya_devices').find(d => d.enabled && d.dps && Object.prototype.hasOwnProperty.call(d.dps, entity));
    return host ? (host.name || host.dev_id) : '';
  }
  return '';
}

// State selectors send { value }; Home Assistant wants it under the field
// its service defines (select.select_option takes `option`, and so on).
const HA_VALUE_FIELD = {
  'select.select_option': 'option', 'input_select.select_option': 'option',
  'climate.set_hvac_mode': 'hvac_mode', 'climate.set_fan_mode': 'fan_mode', 'climate.set_preset_mode': 'preset_mode',
  'climate.set_temperature': 'temperature', 'fan.set_percentage': 'percentage', 'fan.set_preset_mode': 'preset_mode',
};
function haServiceData(action, params) {
  const data = { ...(params || {}) };
  const service = typeof action === 'string' ? action : (action && action.domain ? `${action.domain}.${action.service}` : '');
  const field = HA_VALUE_FIELD[service];
  if (field && data.value !== undefined && data[field] === undefined) {
    data[field] = data.value;
    delete data.value;
  }
  return data;
}


// Transport calls, looked up at call time so tests can swap them.
const adapters = {
  ha: (...a) => require('./ha').executeHAAction(...a),
  mqtt: (...a) => require('./mqtt').executeMqttAction(...a),
  tuya: (...a) => require('./tuya').executeTuyaAction(...a),
  modbus: (...a) => require('./modbus').executeModbusAction(...a),
  rs232: (...a) => require('./rs232').executeRs232ProfileAction(...a),
  dongle: (...a) => require('./dongle').executeDongleAction(...a),
  recordMetric: (...a) => require('./database').queueMetricValue(...a),
};

/**
 * @param {object} spec - { source, action, entity, device, params }
 * @param {object} [ctx] - { req, logSource, bypassSwitch }
 *   logSource defaults to 'action:<source>'. bypassSwitch skips the "Allow
 *   device changes" switch and is honoured only for 'automation:' log sources.
 * @returns {Promise<{status:number, body:object}>}
 */
async function performAction(spec, ctx = {}) {
  const { source, action, entity, params } = spec || {};
  const req = ctx.req;
  const logSource = ctx.logSource || 'action:' + String(source || '');
  const opts = { source: logSource, bypassSwitch: !!ctx.bypassSwitch };
  const logged = (outcome, detail) => deviceControls.logAttempt({ source: logSource, device: spec && spec.device, target: entity, label: action,
    newValue: params && (params.value !== undefined ? params.value : params.payload), outcome, detail }, req);
  const reply = (status, body) => ({ status, body });

  if (!source || !action) {
    logged('refused', 'source and action are required');
    return reply(400, { success: false, error: 'source and action are required' });
  }
  // "Allow device changes" covers every card, whatever the source (Home
  // Assistant, MQTT and Tuya included), not only register writes.
  const switchedOff = deviceControls.mayBypassSwitch(opts) ? null : deviceControls.writeRefusal();
  if (switchedOff) {
    logged('refused', switchedOff);
    return reply(403, { success: false, error: switchedOff });
  }
  const device = resolveActionDevice(source, spec.device, entity);
  if (!device) {
    logged('refused', 'No device configured for this entity');
    return reply(400, { success: false, error: 'device is required (none configured for this entity)' });
  }

  try {
    let result;
    switch (source) {
      case 'ha':
        // Route form of the spec signature: (deviceId, action, entityId, params);
        // `action` may be a dotted string 'domain.service' or an object {domain, service}.
        result = await adapters.ha(device, action, entity, haServiceData(action, params));
        break;
      case 'mqtt': {
        // Topic is the entity; payload comes from params.payload (or a state
        // selector's params.value) or is inferred from the action.
        let payload = params?.payload !== undefined && params?.payload !== null ? params.payload : params?.value;
        if (payload === undefined || payload === null) {
          if (action === 'turn_on') payload = 'ON';
          else if (action === 'turn_off') payload = 'OFF';
          else if (action === 'toggle') {
            // Flip the entity's current state; default to 'ON' when unknown.
            // The entity is a topic — read the metric that topic feeds.
            const mqttDevice = JSON.parse(getConfig('mqtt_devices') || '[]').find(d => d && d.broker === device);
            const metricName = Object.entries(mqttDevice?.topics || {}).find(([, t]) => t === entity)?.[0] || entity;
            const cur = getCurrentMetrics()[metricName]?.value;
            const isOn = cur === 'on' || cur === 'ON' || cur === 'true' || cur === '1' || cur === 1 || cur === true;
            payload = isOn ? 'OFF' : 'ON';
          } else {
            payload = '';
          }
        }
        result = await adapters.mqtt(device, entity, payload);
        break;
      }
      case 'tuya': {
        // Resolve the device by NAME or dev_id from the tuya_devices config
        const tuyaDevices = JSON.parse(getConfig('tuya_devices') || '[]');
        const tuyaDevice = tuyaDevices.find(d => d && (d.name === device || d.dev_id === device));
        if (!tuyaDevice || !tuyaDevice.enabled) {
          result = { success: false, error: 'Tuya device not found or disabled' };
          break;
        }
        // Map entity → DP number via the device's dps config (dps: { metricName: dpNumber })
        const dpMap = tuyaDevice.dps || {};
        let dpNumber;
        for (const [dpName, dpNum] of Object.entries(dpMap)) {
          if (dpName === entity) { dpNumber = dpNum; break; }
        }
        if (dpNumber === undefined || dpNumber === null) {
          result = { success: false, error: 'DP not found' };
          break;
        }
        // Toggles send true when no explicit value is given — never the literal 'undefined'
        const actionValue = (params?.value === undefined || params?.value === null) ? true : params.value;
        result = await adapters.tuya(device, dpNumber, actionValue);
        // The device is polled every 30 s but the Controls page refreshes every
        // 10 s: record the value it now has, so no refresh shows the old one.
        if (result && !result.error && result.success !== false) {
          adapters.recordMetric(entity, actionValue, Math.floor(Date.now() / 1000));
        }
        break;
      }
      case 'modbus':
        // (deviceName, registerAddr, value, type) — register = entity, type='coil' for coils
        result = await adapters.modbus(device, entity, params?.value, params?.type);
        break;
      case 'rs232':
        // Profile form (deviceName, commandName, value) — the switch/stateSelect
        // components send action = command name and params.value = value.
        result = await adapters.rs232(device, action, params?.value);
        break;
      case 'dongle': {
        // (deviceName, registerAddr, value). The entity may be a namespaced id
        // from the profile entity catalog ('holding:0x0069') or a bare hex
        // register — hand only the register address to the transport. Action
        // strings other than 'write' pass through untouched (executeDongleAction
        // is write-only today; presets are reserved for later).
        // A register in the device's list of settings goes through the same
        // checks as the Controls page (read first, range, step, below/above,
        // read back); changeSetting logs it, so return its answer as is.
        const listed = deviceControls.listedSettingFor(device, entity);
        if (listed) {
          const raw = Number(params?.value);
          const changed = await deviceControls.changeSetting({ device, setting: listed.name, value: Number.isFinite(raw) ? Number((raw * listed.scale).toPrecision(12)) : params?.value }, req, opts);
          return reply(changed.success ? 200 : changed.written ? 502 : 400, changed);
        }
        const registerAddr = typeof entity === 'string' && entity.includes(':') ? entity.split(':').pop() : entity;
        result = await adapters.dongle(device, registerAddr, params?.value);
        break;
      }
      default:
        logged('refused', 'Source not supported');
        return reply(501, { success: false, error: 'Source not yet supported' });
    }

    if (result?.error) {
      logged('failed', result.error);
      return reply(502, { success: false, ...result });
    }
    logged('done', '');
    return reply(200, result);
  } catch (e) {
    logger.error('Action error:', e);
    logged('failed', e.message);
    return reply(500, { success: false, error: 'Action failed' });
  }
}

module.exports = { performAction, resolveActionDevice, haServiceData, adapters };
