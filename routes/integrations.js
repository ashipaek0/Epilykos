/**
 * Home Assistant and MQTT routes (mounted at /api): Home Assistant device and entity lists and the actions an
 * entity offers, the switchable entities, and MQTT test connections, topic discovery and its cache.
 * Signed-in only. Credentials travel in POST bodies, never in URLs.
 *
 * @module routes/integrations
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, setConfig, getDb, resolveStoredSecret } = require('../modules/database');
const { isAuthenticated } = require('../modules/sessionAuth');
const { stringFields } = require('../modules/requestFields');
const { assertSafeFetchUrl, assertSafeBrokerUrl, trimSlashes } = require('../modules/utils');
const { fetchHAEntities, haApiUrl, getActionsForEntity, getEntityActions, getEntityModes } = require('../modules/ha');

const router = express.Router();

// Domain set shared with modules/ha.js fetchHAEntities (select/input_select
// so state selectors can drive them).
const HA_CATALOG_DOMAINS = ['sensor', 'binary_sensor', 'switch', 'light', 'climate', 'fan', 'cover', 'input_boolean', 'select', 'input_select', 'button', 'input_button', 'scene', 'script'];

function haStatesToCatalog(states) {
  // AC-10: enrich ONE /api/states fetch into catalog items (no registry, no
  // websocket). The legacy /api/ha-device-entities (entity_id strings only)
  // stays untouched — both endpoints remain callable.
  const items = [];
  if (!Array.isArray(states)) return items;
  for (const e of states) {
    if (!e || typeof e.entity_id !== 'string' || e.entity_id === '') continue;
    const domain = e.entity_id.split('.')[0];
    if (!HA_CATALOG_DOMAINS.includes(domain)) continue;
    const attrs = (e.attributes && typeof e.attributes === 'object' && !Array.isArray(e.attributes)) ? e.attributes : {};
    const friendly = (typeof attrs.friendly_name === 'string' && attrs.friendly_name !== '')
      ? attrs.friendly_name : e.entity_id;
    items.push({
      id: e.entity_id, // persisted handle (entity_id)
      entity_id: e.entity_id,
      domain,
      label: friendly,
      name: friendly,
      unit_of_measurement: attrs.unit_of_measurement !== undefined ? attrs.unit_of_measurement : null,
      device_class: attrs.device_class !== undefined ? attrs.device_class : null,
      state: e.state !== undefined ? e.state : null,
      attributes: attrs,
      kind: 'ha'
    });
  }
  return items;
}

function mqttSampleOf(rawText, retained) {
  // AC-12: type inference for one MQTT payload sample. rawText is the payload
  // already capped at 200 chars by the caller. Types: number (full-string
  // numeric literal), boolean ('true'/'false', case-insensitive like the repo's
  // saveMetric convention), else string — plain text AND JSON payloads collapse
  // to 'string' (JSON→string per AC-12).
  const s = String(rawText).trim();
  const retainedFlag = !!retained;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return { value: n, type: 'number', raw: String(rawText), retained: retainedFlag };
  }
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false') return { value: lower === 'true', type: 'boolean', raw: String(rawText), retained: retainedFlag };
  return { value: String(rawText), type: 'string', raw: String(rawText), retained: retainedFlag };
}

// Plain-language reason a Home Assistant request failed, for the UI.
function haErrorResponse(err, url) {
  const status = err && err.haStatus;
  if (status === 401 || status === 403) return { code: 502, error: 'Home Assistant rejected the access token. Create a new long-lived token and paste it in.' };
  if (status === 404) return { code: 502, error: `Home Assistant's API wasn't found at ${url}. Check the address (it usually ends in :8123).` };
  if (status) return { code: 502, error: `Home Assistant answered with error ${status}.` };
  const cause = (err && err.cause && err.cause.code) || (err && err.name);
  if (cause === 'TimeoutError' || cause === 'UND_ERR_CONNECT_TIMEOUT') return { code: 504, error: `Home Assistant at ${url} didn't answer within 5 seconds.` };
  if (cause === 'ECONNREFUSED') return { code: 502, error: `Nothing is listening at ${url}. Check the address and port.` };
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') return { code: 502, error: `Couldn't find ${url}. Check the address.` };
  if (cause === 'ECONNRESET' || cause === 'EPROTO' || /SSL|TLS|certificate/i.test(String(err && err.cause && err.cause.message))) return { code: 502, error: `The connection to ${url} failed. If it starts with https, try http (or the reverse).` };
  return { code: 500, error: 'Internal server error' };
}

router.use('/ha-device-entities', isAuthenticated);
router.post('/ha-device-entities', async (req, res) => {
  const body = stringFields(req.body);
  const { url } = body;
  const token = resolveStoredSecret(body.token, ['ha_devices', 'ha_token']);
  if (!url || !token) return res.status(400).json({ error: 'HA URL and token required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    res.json(await fetchHAEntities(safeUrl, token));
  } catch (err) {
    logger.error('Error fetching HA entities:', err);
    const { code, error: msg } = haErrorResponse(err, url);
    res.status(code).json({ error: msg });
  }
});

// AC-10 (#108): enriched HA entity catalog — ONE /states fetch, same SSRF guard
// as /api/ha-device-entities above (allowPrivate:true), same 8-domain filter
// (ha.js L147-156), items enriched with friendly_name/unit/device_class/state/
// attributes. Pure projection (haStatesToCatalog) — no registry, no websocket,
// no writes. The legacy string-array endpoint above is untouched.
router.use('/ha/entities', isAuthenticated);
router.post('/ha/entities', async (req, res) => {
  const body = stringFields(req.body);
  const { url } = body;
  const token = resolveStoredSecret(body.token, ['ha_devices', 'ha_token']);
  if (!url || !token) return res.status(400).json({ error: 'HA URL and token required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    // CodeQL-recognized sanitizer (mirrors ha.js fetchHAEntities): parse to a
    // URL object, enforce http/https, and pass the URL OBJECT to fetch.
    let u;
    try { u = new URL(String(safeUrl)); } catch (_) { return res.status(400).json({ error: 'Invalid HA URL' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return res.status(400).json({ error: 'HA URL scheme not allowed (must use http or https)' });
    }
    let p = trimSlashes(u.pathname);
    if (p === '') p = '/api';
    else if (!p.endsWith('/api')) p = p + '/api';
    u.pathname = p + '/states';
    const response = await fetch(u, {
      headers: { 'Authorization': `Bearer ${token}` },
      redirect: 'error', // never forward the HA token to a redirect target
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw Object.assign(new Error(`HA error ${response.status} for GET ${u.toString()}`), { haStatus: response.status });
    const states = await response.json();
    res.json(haStatesToCatalog(states));
  } catch (err) {
    logger.error('Error fetching HA entity catalog:', err);
    const { code, error: msg } = haErrorResponse(err, url);
    res.status(code).json({ error: msg });
  }
});

// Resolve the last-known state of an entity from the latest_metrics table via
// the ha_devices mapping (used when the request does not carry url/token).
function findLatestStateForEntity(entityId) {
  try {
    const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
    for (const device of haDevices) {
      for (const [metric, mapping] of Object.entries(device.entities || {})) {
        // Mapping value is either a plain entity_id string or an object
        // { entityId, actions: [...] } carrying action metadata (AC-1.4).
        const eid = (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) ? mapping.entityId : mapping;
        if (eid === entityId) {
          const row = getDb().prepare('SELECT value, value_text, value_type FROM latest_metrics WHERE metric = ?').get(metric);
          if (row) {
            return { entity_id: entityId, state: row.value_text != null ? row.value_text : row.value };
          }
        }
      }
    }
  } catch (err) {
    logger.warn('findLatestStateForEntity error:', err.message);
  }
  return null;
}

router.get('/switchable-entities', isAuthenticated, (req, res) => {
  try { res.json(require('../modules/switchables').switchableEntities()); } catch (err) {
    logger.error('Error listing switchable entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/entity-actions', isAuthenticated);
router.get('/entity-actions', (req, res) => {
  const { entity } = req.query;
  if (!entity || typeof entity !== 'string' || entity.length > 128) {
    return res.status(400).json({ error: 'Valid entity ID required' });
  }
  res.json({ actions: getEntityActions(entity) });
});

// Spec AC-7.4 — auto-discovery: actions + modes + current state for one entity.
// Auth: isAuthenticated (session). CSRF: the global /api csrfProtection requires
// X-Requested-With on POSTs — settings.js sends it.
router.use('/ha/entity-actions', isAuthenticated);
router.post('/ha/entity-actions', async (req, res) => {
  const { device: deviceRef, entityId } = req.body || {};
  if (!entityId || typeof entityId !== 'string') {
    return res.status(400).json({ error: 'Valid entity ID required' });
  }
  const trimmed = entityId.trim();
  if (trimmed.length > 128 || !/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(trimmed)) {
    return res.status(400).json({ error: 'Valid entity ID required (domain.entity)' });
  }
  // SSRF guard: resolve the HA device from server-side config only — never
  // trust client-supplied url/token. Mirrors executeHAAction lookup.
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  let device = null;
  if (typeof deviceRef === 'string' && deviceRef !== '') {
    device = haDevices.find(d => d && d.name === deviceRef);
    if (!device && /^\d+$/.test(deviceRef)) {
      device = haDevices[Number(deviceRef)];
    }
  }
  if (device && !device.enabled) device = null;
  if (typeof deviceRef === 'string' && deviceRef !== '' && !device) {
    return res.status(404).json({ error: 'HA device not found' });
  }
  const url = device?.url;
  const token = device?.token;
  const entityIdOk = trimmed;
  if (device && (!url || !token)) {
    return res.status(400).json({ error: 'Configured HA device is missing url/token' });
  }
  try {
    const actions = getActionsForEntity(entityIdOk);
    let modes = { hvac_modes: [], fan_modes: [], preset_modes: [], options: [], min_temp: null, max_temp: null };
    let currentState = null;
    if (url && token) {
      const [modeData, stateRes] = await Promise.all([
        getEntityModes(url, token, entityIdOk),
        fetch(haApiUrl(url, 'states/' + entityIdOk), {
          headers: { 'Authorization': `Bearer ${token}` },
          redirect: 'error', // never forward the HA token to a redirect target
          signal: AbortSignal.timeout(5000)
        }).catch(() => null)
      ]);
      modes = modeData;
      if (stateRes && stateRes.ok) {
        const st = await stateRes.json().catch(() => null);
        if (st && st.entity_id) {
          currentState = { entity_id: st.entity_id, state: st.state, attributes: st.attributes || {} };
        }
      }
    } else {
      // No device context: DB-only fallback — never fetch with client data.
      currentState = findLatestStateForEntity(entityIdOk);
    }
    res.json({ actions, modes, currentState });
  } catch (err) {
    logger.error('Error in /api/ha/entity-actions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/test-mqtt', isAuthenticated);
router.post('/test-mqtt', async (req, res) => {
  const body = stringFields(req.body);
  // Support pre-save testing: accept broker/username/password from query params
  const broker = body.broker || (() => {
    const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
    const device = devices.find(d => d.enabled);
    return device?.broker;
  })();
  const username = body.username || null;
  const password = resolveStoredSecret(body.password, ['mqtt_devices', 'mqtt_password']) || null;
  if (!broker) return res.status(400).json({ error: 'No MQTT broker configured. Enter a broker URL first.' });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  const testClient = require('mqtt').connect(safe.url, options);
  let responded = false;
  const timeout = setTimeout(() => {
    // Mark answered first: a late 'error' event must not reply again (that throws and kills the process).
    if (!responded) { responded = true; testClient.end(); res.status(500).json({ error: 'Connection timeout' }); }
  }, 5000);
  testClient.on('connect', () => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; res.json({ success: true, message: 'Connected to MQTT broker' }); }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; logger.error('MQTT test connection error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
  });
});

router.use('/test-mqtt-topic', isAuthenticated);
router.post('/test-mqtt-topic', async (req, res) => {
  const body = stringFields(req.body);
  const topic = body.topic;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  // Support pre-save testing: accept broker/username/password from query params
  const broker = body.broker || (() => {
    const devices = JSON.parse(getConfig('mqtt_devices') || '[]');
    const device = devices.find(d => d.enabled);
    return device?.broker;
  })();
  const username = body.username || null;
  const password = resolveStoredSecret(body.password, ['mqtt_devices', 'mqtt_password']) || null;
  if (!broker) return res.status(400).json({ error: 'No MQTT broker configured' });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  const testClient = require('mqtt').connect(safe.url, options);
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) { responded = true; testClient.end(); res.status(500).json({ error: 'No message received within 5 seconds' }); }
  }, 5000);
  testClient.on('connect', () => testClient.subscribe(topic));
  testClient.on('message', (recTopic, message) => {
    if (recTopic === topic) {
      clearTimeout(timeout);
      testClient.end();
      if (!responded) {
        responded = true;
        const val = parseFloat(message.toString());
        if (!isNaN(val)) res.json({ success: true, value: val });
        else res.json({ success: true, value: null, raw: message.toString() });
      }
    }
  });
  testClient.on('error', (err) => {
    clearTimeout(timeout);
    testClient.end();
    if (!responded) { responded = true; logger.error('MQTT topic test error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
  });
});

// ── MQTT topic discovery ────────────────────────────────────────
router.use('/mqtt-discover-topics', isAuthenticated);
router.post('/mqtt-discover-topics', async (req, res) => {
  const body = stringFields(req.body);
  const broker = body.broker;
  const username = body.username || null;
  const password = resolveStoredSecret(body.password, ['mqtt_devices', 'mqtt_password']) || null;
  if (!broker) return res.status(400).json({ error: 'Broker URL required' });
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  const options = {};
  if (username) options.username = username;
  if (password) options.password = password;
  const mqtt = require('mqtt');
  const client = mqtt.connect(safe.url, options);
  let responded = false;
  const topics = new Set();
  // AC-12 (#108): during the 15s window also keep the LAST message payload per
  // topic (payload capped at 200 chars) so the response can carry typed
  // samples; on window end the window is persisted under mqtt_discovery_cache.
  const lastMessageByTopic = new Map();
  const PAYLOAD_CAP = 200;
  const MAX_ENTRIES = 2000;
  const timeout = setTimeout(() => {
    client.end();
    if (!responded) {
      responded = true;
      const sorted = [...topics].sort();
      const entries = [...lastMessageByTopic.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_ENTRIES)
        .map(([topic, sample]) => ({ topic, sample }));
      persistMqttDiscoveryCache(safe.url, entries); // AC-12 — the only config write of the catalog slice
      res.json({ success: true, topics: sorted, count: sorted.length, entries });
    }
  }, 15000);
  client.on('connect', () => {
    client.subscribe('#', (err) => {
      if (err) {
        clearTimeout(timeout);
        client.end();
        if (!responded) { responded = true; logger.error('MQTT subscribe error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
      }
    });
  });
  client.on('message', (topic, message) => {
    if (typeof topic !== 'string') return;
    topics.add(topic);
    let text = '';
    try { text = message.toString('utf8'); } catch (_) { text = ''; }
    lastMessageByTopic.set(topic, mqttSampleOf(text.slice(0, PAYLOAD_CAP), !!(message && message.retain)));
  });
  client.on('error', (err) => {
    clearTimeout(timeout);
    client.end();
    if (!responded) { responded = true; logger.error('MQTT discover error:', err.message); res.status(500).json({ error: 'Internal server error' }); }
  });
});

// AC-12 (#108): cached MQTT discovery window — returned WITHOUT listening (D9),
// so the MQTT card can re-hydrate rows from a previous 15s window. The broker
// key is the same assertSafeBrokerUrl-normalized URL used at persist time, so
// lookups always match.
router.use('/mqtt-discovery-cache', isAuthenticated);
router.get('/mqtt-discovery-cache', (req, res) => {
  const broker = req.query.broker;
  if (!broker) return res.status(400).json({ error: 'Broker URL required' });
  const safe = assertSafeBrokerUrl(broker);
  if (!safe.ok) return res.status(400).json({ error: safe.error });
  try {
    const cache = JSON.parse(getConfig('mqtt_discovery_cache') || '{}');
    const hit = cache && typeof cache === 'object' ? cache[safe.url] : null;
    res.json({
      success: true,
      broker: safe.url,
      ts: hit ? hit.ts : null,
      entries: hit && Array.isArray(hit.entries) ? hit.entries : []
    });
  } catch (err) {
    logger.error('Error reading mqtt_discovery_cache:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AC-12 (#108): persist one broker's discovery window under the additive
// mqtt_discovery_cache config key — keyed by normalized broker URL, capped at
// MAX_ENTRIES topics, additive per broker (never reads/writes mqtt_devices; a
// later window for the same broker replaces only that broker's entry).
function persistMqttDiscoveryCache(brokerUrlKey, entries) {
  try {
    const cache = JSON.parse(getConfig('mqtt_discovery_cache') || '{}');
    cache[brokerUrlKey] = { ts: Date.now(), broker: brokerUrlKey, entries };
    setConfig('mqtt_discovery_cache', JSON.stringify(cache));
  } catch (err) {
    logger.error('Error persisting mqtt_discovery_cache:', err.message);
  }
}

module.exports = router;
module.exports.haStatesToCatalog = haStatesToCatalog;
module.exports.mqttSampleOf = mqttSampleOf;
module.exports.haErrorResponse = haErrorResponse;
