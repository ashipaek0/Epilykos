/**
 * Grid Status Tracking
 *
 * Binary sensor: 1 = grid ON, 0 = grid OFF.
 * Records state changes in grid_status table. Computes cumulative ON time
 * for day/week/month/year and a 24h timeline of state segments.
 *
 * Issue #64 fixes:
 * - Text-aware metric reads: HA binary_sensor states are stored in
 *   latest_metrics.value_text/value_type (value stays NULL), so read
 *   `value_text ?? value` instead of only `value`.
 * - HA fallback resolves the entity from the device that actually HOSTS it
 *   (match by metric-name key or entity_id across ALL enabled devices), not
 *   merely the first enabled device.
 * - No silent-swallow: every unresolvable state gets a warn log line.
 * - getGridHours returns minute-level precision (no 0.1h rounding), so a
 *   2-minute supply event survives to the frontend (D3).
 *
 * @module grid
 */
const { logger } = require('./logger');
const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');
const { parseGridState } = require('./utils');

// Rate-limit unresolvable-state warnings (poller runs every 30s; don't flood logs)
let lastUnresolvableWarn = 0;

/**
 * Read the grid state from latest_metrics, text-aware.
 * @param {string} gridMetric - config grid_status_entity (metric name or entity_id)
 * @returns {number|null} 0/1 or null when the row is missing/unresolvable.
 */
function readLatestGridState(gridMetric) {
  const db = getDb();
  const row = db.prepare('SELECT value, value_text, value_type FROM latest_metrics WHERE metric = ?').get(gridMetric);
  if (!row) return null;
  const raw = row.value != null ? row.value : row.value_text;
  if (raw === null || raw === undefined) {
    logger.warn(`Grid: metric '${gridMetric}' in latest_metrics has neither value nor value_text`);
    return null;
  }
  const state = parseGridState(raw);
  if (state === null) {
    logger.warn(`Grid: metric '${gridMetric}' state '${raw}' (type=${row.value_type}) is unresolvable`);
  }
  return state;
}

/**
 * Find the enabled HA device that hosts the grid entity.
 * Matches either by metric-name key (e.g. entities['Grid Status']) or by
 * entity_id value (e.g. 'binary_sensor.grid_status') across ALL enabled
 * devices — NOT just the first one.
 * @param {string} gridMetric - metric name or entity_id from config
 * @returns {{device: object, entityId: string}|null}
 */
function resolveGridEntityHost(gridMetric) {
  const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
  for (const device of haDevices) {
    if (!device.enabled || !device.url || !device.token) continue;
    const entities = device.entities || {};
    // Metric-name key match (config holds a metric name like 'Grid Status')
    if (entities[gridMetric]) return { device, entityId: entities[gridMetric] };
    // Entity-id value match (config holds the entity_id itself)
    for (const [metric, entityId] of Object.entries(entities)) {
      if (entityId === gridMetric) return { device, entityId };
    }
  }
  return null;
}

/**
 * Fetch the grid state from the HA device that hosts the entity.
 * @param {string} gridMetric - metric name or entity_id from config
 * @returns {Promise<number|null>} 0/1 or null (always logged, never silent)
 */
async function fetchGridStateFromHA(gridMetric) {
  const host = resolveGridEntityHost(gridMetric);
  if (!host) {
    logger.warn(`Grid: entity '${gridMetric}' not in latest_metrics and not hosted by any enabled HA device`);
    return null;
  }
  const { device, entityId } = host;
  try {
    const res = await fetch(`${device.url}/api/states/${entityId}`, {
      headers: { 'Authorization': `Bearer ${device.token}` },
      timeout: 5000
    });
    if (!res.ok) {
      logger.warn(`Grid: HA fetch for '${entityId}' on '${device.name}' returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const state = parseGridState(data.state);
    if (state === null) {
      logger.warn(`Grid: HA state '${data.state}' for '${entityId}' on '${device.name}' is unresolvable`);
    }
    return state;
  } catch (e) {
    logger.warn(`Grid: HA fetch failed for '${entityId}' on '${device.name}': ${e.message}`);
    return null;
  }
}

/**
 * Resolve the current grid state: latest_metrics first (text-aware), then the
 * HA device hosting the entity. Always logs on failure — never silent.
 * @param {string} gridMetric - config grid_status_entity
 * @returns {Promise<number|null>} 0/1 or null
 */
async function resolveGridState(gridMetric) {
  if (!gridMetric) {
    logger.debug('Grid: grid_status_entity not configured; tracking disabled');
    return null;
  }
  const fromMetrics = readLatestGridState(gridMetric);
  if (fromMetrics !== null) return fromMetrics;
  return fetchGridStateFromHA(gridMetric);
}

/** Warn (rate-limited) about an unresolvable grid state. */
function warnUnresolvable(gridMetric) {
  const now = Date.now();
  if (now - lastUnresolvableWarn > 5 * 60 * 1000) {
    logger.warn(`Grid: state for '${gridMetric}' unresolvable; no transition recorded this cycle`);
    lastUnresolvableWarn = now;
  }
}

/** Poll binary grid metric, record state changes with 60s debounce. */
async function pollGridStatus() {
  const db = getDb();
  const gridMetric = getConfig('grid_status_entity');
  if (!gridMetric) {
    logger.debug('Grid: grid_status_entity not configured; poll skipped');
    return;
  }

  const state = await resolveGridState(gridMetric);
  if (state === null) {
    warnUnresolvable(gridMetric);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const last = db.prepare('SELECT timestamp, state FROM grid_status ORDER BY timestamp DESC LIMIT 1').get();
  // Record only when state actually changes, with 60s minimum dwell time
  if (!last || last.state !== state) {
    if (last && (now - last.timestamp) < 60) {
      logger.debug(`Grid: state change within 60s dwell skipped (last ${now - last.timestamp}s ago)`);
      return;
    }
    db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(now, state);
    logger.info(`Grid ${state ? 'ON' : 'OFF'} at ${new Date(now * 1000).toISOString()}`);
  }
}

/** Return current grid state and last ON/OFF timestamps. */
async function getCurrentGridStatus() {
  const gridMetric = getConfig('grid_status_entity');
  if (!gridMetric) return { configured: false, available: false };
  const db = getDb();

  const state = await resolveGridState(gridMetric);
  const available = state !== null;

  const row = db.prepare(`SELECT
    (SELECT state FROM grid_status ORDER BY timestamp DESC LIMIT 1) AS last_change_state,
    MAX(CASE WHEN state = 1 THEN timestamp END) AS last_on,
    MAX(CASE WHEN state = 0 THEN timestamp END) AS last_off,
    MAX(timestamp) AS last_change_ts
  FROM grid_status`).get();

  return {
    configured: true,
    available,
    current: state === 1,
    lastOn:  row.last_on  ? row.last_on  * 1000 : null,
    lastOff: row.last_off ? row.last_off * 1000 : null,
    lastChange: row.last_change_ts ? { time: row.last_change_ts * 1000, state: row.last_change_state } : null
  };
}

/** Compute cumulative ON hours within a time period. */
async function getGridHours(period) {
  const db = getDb();
  const now = new Date();
  let start;

  if (period === 'day') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    const d = now.getDay();
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (d === 0 ? 6 : d - 1));
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === 'year') {
    start = new Date(now.getFullYear(), 0, 1);
  } else {
    throw new Error('Invalid period');
  }

  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);

  // Get the state before period start as initial
  const before = db.prepare('SELECT state FROM grid_status WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(startUnix);
  const initialState = before ? before.state : 0;

  const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);

  let hours = 0, lastState = initialState, lastTime = startUnix;
  for (const row of rows) {
    if (lastState === 1) hours += (row.timestamp - lastTime) / 3600;
    lastState = row.state;
    lastTime = row.timestamp;
  }
  // Tail: if currently ON, count from last state change to now
  if (lastState === 1) hours += (endUnix - lastTime) / 3600;

  // Minute-level precision (D3): round to the nearest second of supply, NOT to
  // 0.1h. A 2-minute event (0.0333h) must reach the frontend as 00h:02m.
  return Math.round(hours * 3600) / 3600;
}

/** Build timeline segments for the last 24 hours. */
async function getGridTimeline() {
  const db = getDb();
  const entity = getConfig('grid_status_entity');
  if (!entity) return { configured: false, available: false, segments: [] };

  const now = new Date();
  const endUnix = Math.floor(now.getTime() / 1000);
  const startUnix = endUnix - 24 * 3600;

  const before = db.prepare('SELECT state FROM grid_status WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(startUnix);
  const initialState = before ? before.state : 0;

  const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);

  const segments = [];
  let lastState = initialState, lastTime = startUnix;
  for (const row of rows) {
    if (row.timestamp > lastTime) {
      segments.push({ start: lastTime, end: row.timestamp, state: lastState });
    }
    lastState = row.state;
    lastTime = row.timestamp;
  }
  if (lastTime < endUnix) {
    segments.push({ start: lastTime, end: endUnix, state: lastState });
  }

  return {
    configured: true,
    available: true,
    segments: segments.map(s => ({ start: s.start * 1000, end: s.end * 1000, state: s.state })),
    windowStart: startUnix * 1000,
    windowEnd: endUnix * 1000
  };
}

module.exports = { pollGridStatus, getCurrentGridStatus, getGridHours, getGridTimeline };
