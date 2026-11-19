'use strict';
/**
 * Epilykos metrics as Home Assistant sensors, through MQTT discovery.
 *
 * Settings → Home Assistant gives a broker (the one Home Assistant uses) and a choice of metrics. For each one this
 * publishes a retained discovery message under <prefix>/sensor/<node>/<metric>/config, so the sensor appears in Home
 * Assistant on its own, grouped under one "Epilykos" device with a unit, a device class and a state class that fit.
 * Values go to epilykos/<node>/<metric> when they change (and at most every `interval` seconds). An availability topic
 * with a last will makes the sensors go unavailable if Epilykos stops. A metric that is deselected or deleted has its
 * sensor removed, and "Remove from Home Assistant" clears everything this published.
 *
 * The pure helpers (classify, topics, discoveryPayload, selectRows) hold the rules; createHaDiscovery wires them to a
 * broker connection that is passed in, so tests need no network.
 */

const CONFIG_KEY = 'ha_discovery';
const DEFAULTS = { enabled: false, broker: '', username: '', password: '', prefix: 'homeassistant', node: 'epilykos', mode: 'roles', interval: 10 };

/** Home Assistant allows letters, digits, underscore and hyphen in these parts of a topic. */
function safe(s, fallback) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  let a = 0, b = t.length;                     // trim underscores by hand: a regex for this is slow on long runs of them
  while (a < b && t[a] === '_') a++;
  while (b > a && t[b - 1] === '_') b--;
  return t.slice(a, b) || fallback;
}

/** The settings as stored, with anything missing or odd replaced by its default. */
function normalise(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const interval = Number(r.interval);
  return {
    enabled: r.enabled === true,
    broker: typeof r.broker === 'string' ? r.broker.trim() : '',
    username: typeof r.username === 'string' ? r.username : '',
    password: typeof r.password === 'string' ? r.password : '',
    prefix: safe(r.prefix, DEFAULTS.prefix),
    node: safe(r.node, DEFAULTS.node),
    mode: r.mode === 'all' ? 'all' : 'roles',
    interval: Number.isFinite(interval) ? Math.min(Math.max(Math.round(interval), 1), 3600) : DEFAULTS.interval,
  };
}

/** A broker address Epilykos will connect to: mqtt://, mqtts://, ws:// or wss://, with a host. */
function validBroker(url) {
  try { const u = new URL(url); return ['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(u.protocol) && !!u.hostname; } catch (_) { return false; }
}

// Units Home Assistant pairs with a device class. Anything else is published as a plain sensor.
const UNIT_CLASSES = {
  W: ['power', 'measurement'], kW: ['power', 'measurement'],
  VA: ['apparent_power', 'measurement'], var: ['reactive_power', 'measurement'],
  Wh: ['energy', 'total_increasing'], kWh: ['energy', 'total_increasing'],
  V: ['voltage', 'measurement'], A: ['current', 'measurement'], Hz: ['frequency', 'measurement'],
  '°C': ['temperature', 'measurement'],
};

/** { unit, deviceClass, stateClass } for a metric: what its unit says, and a battery for a percentage that is one. */
function classify(metric, unit) {
  const u = typeof unit === 'string' ? unit.trim() : '';
  if (UNIT_CLASSES[u]) return { unit: u, deviceClass: UNIT_CLASSES[u][0], stateClass: UNIT_CLASSES[u][1] };
  if (u === '%') return { unit: '%', deviceClass: /(^|_)(soc|battery)(_|$)/.test(metric) && !/temp|voltage|current|power/.test(metric) ? 'battery' : null, stateClass: 'measurement' };
  if (u) return { unit: u, deviceClass: null, stateClass: 'measurement' };
  return { unit: null, deviceClass: null, stateClass: null };
}

const humanise = (metric) => { const t = String(metric).replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

function topics(cfg, metric) {
  const m = safe(metric, 'metric');
  return {
    config: `${cfg.prefix}/sensor/${cfg.node}/${m}/config`,
    state: `epilykos/${cfg.node}/${m}`,
    availability: `epilykos/${cfg.node}/status`,
  };
}

/** The discovery message for one metric. */
function discoveryPayload(cfg, row, version) {
  const t = topics(cfg, row.metric);
  const numeric = row.value !== null && row.value !== undefined && row.value_type !== 'string' && row.value_type !== 'boolean';
  const c = numeric ? classify(row.metric, row.unit) : { unit: null, deviceClass: null, stateClass: null };
  const payload = {
    name: humanise(row.metric),
    unique_id: `epilykos_${cfg.node}_${safe(row.metric, 'metric')}`,
    object_id: `epilykos_${safe(row.metric, 'metric')}`,
    state_topic: t.state,
    availability_topic: t.availability,
    has_entity_name: true,
    device: { identifiers: [`epilykos_${cfg.node}`], name: 'Epilykos', manufacturer: 'Epilykos', model: 'Energy dashboard', ...(version ? { sw_version: String(version) } : {}) },
  };
  if (c.unit) payload.unit_of_measurement = c.unit;
  if (c.deviceClass) payload.device_class = c.deviceClass;
  if (c.stateClass) payload.state_class = c.stateClass;
  return payload;
}

/** What goes on the state topic: a number trimmed to four decimals, or the text. null when there is no value. */
function stateText(row) {
  if (row.value !== null && row.value !== undefined && Number.isFinite(Number(row.value)) && row.value_type !== 'string' && row.value_type !== 'boolean') return String(Math.round(Number(row.value) * 10000) / 10000);
  if (row.value_text !== null && row.value_text !== undefined && String(row.value_text) !== '') return String(row.value_text);
  return null;
}

/** The latest_metrics rows to publish: all of them, or only the ones a metric role points at. */
function selectRows(rows, cfg, roles) {
  const withValue = rows.filter(r => stateText(r) !== null);
  if (cfg.mode === 'all') return withValue;
  const chosen = new Set(Object.values(roles || {}).filter(v => typeof v === 'string' && v));
  return withValue.filter(r => chosen.has(r.metric));
}

/**
 * @param {object} deps
 * @param {(url: string, opts: object) => object} deps.connect   mqtt.connect-like: returns an emitter with publish/end/on
 * @param {() => object} deps.readConfig   the stored settings (raw)
 * @param {() => object} deps.readRoles    role_metrics
 * @param {() => object[]} deps.getLatest  rows from latest_metrics
 * @param {(fn: Function) => Function} deps.onFlushed  call fn after readings are stored; returns an unsubscribe
 * @param {string} [deps.version]
 * @param {{info?: Function, warn?: Function}} [deps.log]
 * @param {() => number} [deps.now]
 */
function createHaDiscovery({ connect, readConfig, readRoles, getLatest, onFlushed, version = '', log = {}, now = Date.now }) {
  let client = null, cfg = null, unsub = null;
  const configs = new Set();            // metrics that have a discovery message out there
  const lastState = new Map();          // metric -> last published text
  const lastAt = new Map();             // metric -> when (ms)
  const status = { state: 'off', error: '', sensors: 0, lastPublishAt: null };

  const pub = (topic, payload, retain = true) => { try { client.publish(topic, payload, { qos: 1, retain }); } catch (e) { status.error = e.message; } };

  function sync(force) {
    if (!client || !cfg || status.state !== 'connected') return;
    const rows = selectRows(getLatest(), cfg, readRoles());
    const wanted = new Set(rows.map(r => r.metric));
    for (const metric of [...configs]) {
      if (wanted.has(metric)) continue;
      pub(topics(cfg, metric).config, '');
      pub(topics(cfg, metric).state, '');
      configs.delete(metric); lastState.delete(metric); lastAt.delete(metric);
    }
    for (const row of rows) {
      const t = topics(cfg, row.metric);
      if (!configs.has(row.metric) || force) { pub(t.config, JSON.stringify(discoveryPayload(cfg, row, version))); configs.add(row.metric); }
      const text = stateText(row);
      const t0 = lastAt.get(row.metric) || 0;
      if (text === lastState.get(row.metric) && !force) continue;
      if (!force && now() - t0 < cfg.interval * 1000) continue;
      pub(t.state, text);
      lastState.set(row.metric, text); lastAt.set(row.metric, now());
      status.lastPublishAt = now();
    }
    status.sensors = configs.size;
  }

  function stop(quiet) {
    if (unsub) { unsub(); unsub = null; }
    if (client) {
      const c = client; client = null;
      try { if (!quiet && status.state === 'connected') c.publish(topics(cfg || normalise({}), 'x').availability, 'offline', { qos: 1, retain: true }); } catch (_) { /* closing */ }
      try { c.removeAllListeners && c.removeAllListeners(); c.end(true); } catch (_) { /* already closed */ }
    }
    configs.clear(); lastState.clear(); lastAt.clear();
    status.state = 'off'; status.sensors = 0;
  }

  function start() {
    stop();
    cfg = normalise(readConfig());
    status.error = '';
    if (!cfg.enabled || !cfg.broker) return;
    if (!validBroker(cfg.broker)) { status.state = 'error'; status.error = 'The broker address must start with mqtt://, mqtts://, ws:// or wss://.'; return; }
    status.state = 'connecting';
    const opts = { clientId: `epilykos-${cfg.node}-ha`, reconnectPeriod: 5000, will: { topic: topics(cfg, 'x').availability, payload: 'offline', retain: true, qos: 1 } };
    if (cfg.username) opts.username = cfg.username;
    if (cfg.password) opts.password = cfg.password;
    client = connect(cfg.broker, opts);
    client.on('connect', () => {
      status.state = 'connected'; status.error = '';
      pub(topics(cfg, 'x').availability, 'online');
      configs.clear(); lastState.clear();
      sync(true);
      if (log.info) log.info(`Home Assistant discovery: connected, ${status.sensors} sensors published`);
    });
    client.on('error', err => { status.error = err && err.message ? err.message : 'Connection error'; if (status.state !== 'connected') status.state = 'error'; });
    client.on('close', () => { if (client && status.state === 'connected') status.state = 'connecting'; });
    unsub = onFlushed(() => sync(false));
  }

  /** Wait for a connection (or a failure) on a client. */
  function opened(c, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('The broker did not answer in time.')); }, ms);
      c.on('connect', () => { clearTimeout(timer); resolve(); });
      c.on('error', err => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); });
    });
  }

  function publishAll(c, items) {
    return Promise.all(items.map(([topic, payload]) => new Promise(resolve => {
      try { c.publish(topic, payload, { qos: 1, retain: true }, () => resolve()); } catch (_) { resolve(); }
    })));
  }

  /**
   * Remove every sensor this published. Works when Home Assistant discovery is switched off too: it connects with
   * the saved settings just for this. Resolves with how many sensors were cleared.
   */
  async function removeAll() {
    const c = normalise(readConfig());
    if (!c.broker || !validBroker(c.broker)) throw new Error('Save the broker address first, so Epilykos knows where to remove the sensors from.');
    const metrics = new Set([...configs, ...getLatest().map(r => r.metric)]);
    const items = [];
    for (const metric of metrics) items.push([topics(c, metric).config, ''], [topics(c, metric).state, '']);
    items.push([topics(c, 'x').availability, '']);
    const live = client && status.state === 'connected';
    if (live) await publishAll(client, items);
    else {
      const tmp = connect(c.broker, { clientId: `epilykos-${c.node}-ha-clear`, ...(c.username ? { username: c.username } : {}), ...(c.password ? { password: c.password } : {}), reconnectPeriod: 0 });
      try { await opened(tmp, 8000); await publishAll(tmp, items); } finally { try { tmp.end(true); } catch (_) { /* closed */ } }
    }
    const removed = metrics.size;
    stop(true);   // the availability topic was just cleared; do not leave an "offline" behind
    return { removed };
  }

  /** Can Epilykos reach this broker with these settings? An empty password keeps the saved one. */
  async function test(input) {
    const saved = normalise(readConfig());
    const c = normalise({ ...saved, ...(input || {}) });
    if (!(input && typeof input.password === 'string' && input.password)) c.password = saved.password;
    if (!c.broker) throw new Error('Enter the broker address.');
    if (!validBroker(c.broker)) throw new Error('The broker address must start with mqtt://, mqtts://, ws:// or wss://.');
    const tmp = connect(c.broker, { clientId: `epilykos-${c.node}-ha-test`, ...(c.username ? { username: c.username } : {}), ...(c.password ? { password: c.password } : {}), reconnectPeriod: 0 });
    try { await opened(tmp, 8000); } finally { try { tmp.end(true); } catch (_) { /* closed */ } }
    return { ok: true };
  }

  return { start, stop: () => stop(), restart: start, sync: () => sync(false), removeAll, test, status: () => ({ ...status, sensors: configs.size }) };
}

module.exports = { CONFIG_KEY, DEFAULTS, normalise, validBroker, classify, topics, discoveryPayload, stateText, selectRows, createHaDiscovery, safe };
