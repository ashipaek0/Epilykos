/**
 * Grid Status Tracking
 *
 * Binary sensor: 1 = grid ON, 0 = grid OFF.
 * Records state changes in grid_status table. Computes cumulative ON time
 * for day/week/month/year and a 24h timeline of state segments.
 *
 * @module grid
 */
const { logger } = require('./logger');
const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');
const { parseGridState } = require('./utils');

/** Poll binary grid metric, record state changes with 60s debounce. */
async function pollGridStatus() {
  const db = getDb();
  const gridMetric = getConfig('grid_status_entity');
  if (!gridMetric) return;

  let state = null;
  const now = Math.floor(Date.now() / 1000);

  const metricRow = db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get(gridMetric);
  if (metricRow && metricRow.value != null) {
    state = parseGridState(metricRow.value);
  } else {
    const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
    const haDevice = haDevices.find(d => d.enabled);
    if (haDevice?.url && haDevice?.token) {
      try {
        const res = await fetch(`${haDevice.url}/api/states/${gridMetric}`, {
          headers: { 'Authorization': `Bearer ${haDevice.token}` }, timeout: 5000
        });
        if (res.ok) state = parseGridState((await res.json()).state);
      } catch (e) { /* silent */ }
    }
  }

  if (state === null) return;

  const last = db.prepare('SELECT timestamp, state FROM grid_status ORDER BY timestamp DESC LIMIT 1').get();
  // Record only when state actually changes, with 60s minimum dwell time
  if (!last || last.state !== state) {
    if (last && (now - last.timestamp) < 60) return;
    db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(now, state);
    logger.info(`Grid ${state ? 'ON' : 'OFF'} at ${new Date(now * 1000).toISOString()}`);
  }
}

/** Return current grid state and last ON/OFF timestamps. */
async function getCurrentGridStatus() {
  const gridMetric = getConfig('grid_status_entity');
  if (!gridMetric) return { configured: false };
  const db = getDb();

  let current = 0;
  const metricRow = db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get(gridMetric);
  if (metricRow && metricRow.value != null) {
    current = parseGridState(metricRow.value);
  } else {
    const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
    const haDevice = haDevices.find(d => d.enabled);
    if (haDevice?.url && haDevice?.token) {
      try {
        const raw = await fetch(`${haDevice.url}/api/states/${gridMetric}`, {
          headers: { 'Authorization': `Bearer ${haDevice.token}` }, timeout: 5000
        }).then(r => r.json()).then(d => d.state).catch(() => 0);
        current = parseGridState(raw);
      } catch { return { configured: false }; }
    }
  }

  const row = db.prepare(`SELECT
    (SELECT state FROM grid_status ORDER BY timestamp DESC LIMIT 1) AS last_change_state,
    MAX(CASE WHEN state = 1 THEN timestamp END) AS last_on,
    MAX(CASE WHEN state = 0 THEN timestamp END) AS last_off,
    MAX(timestamp) AS last_change_ts
  FROM grid_status`).get();

  return {
    configured: true,
    current: current === 1,
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

  return Math.round(hours * 10) / 10;
}

/** Build timeline segments for the last 24 hours. */
async function getGridTimeline() {
  const db = getDb();
  const entity = getConfig('grid_status_entity');
  if (!entity) return { configured: false, segments: [] };

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
    segments: segments.map(s => ({ start: s.start * 1000, end: s.end * 1000, state: s.state })),
    windowStart: startUnix * 1000,
    windowEnd: endUnix * 1000
  };
}

module.exports = { pollGridStatus, getCurrentGridStatus, getGridHours, getGridTimeline };
