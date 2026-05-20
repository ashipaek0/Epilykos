/**
 * Grid Status Tracking
 *
 * Monitors a binary metric (0/1 or on/off) from any data source via latest_metrics.
 * Records state changes in the grid_status table for uptime hours and timeline.
 * Falls back to Home Assistant entity polling if metric not found in latest_metrics.
 *
 * The configured metric name is stored in config key 'grid_status_entity'.
 *
 * @module grid
 */
const { logger } = require('./logger');
const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');
const { parseGridState } = require('./utils');

/** Poll current grid state from latest_metrics (any source) or HA, record changes */
async function pollGridStatus() {
  const db = getDb();
  const gridMetric = getConfig('grid_status_entity');
  if (!gridMetric) return;

  let state = null;
  const now = Math.floor(Date.now() / 1000);

  // First try reading from latest_metrics (works with any data source)
  const metricRow = db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get(gridMetric);
  if (metricRow && metricRow.value !== null && metricRow.value !== undefined) {
    state = parseGridState(metricRow.value);
  } else {
    // Fall back to HA entity polling
    const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
    const haDevice = haDevices.find(d => d.enabled);
    if (haDevice && haDevice.url && haDevice.token) {
      try {
        const res = await fetch(`${haDevice.url}/api/states/${gridMetric}`, {
          headers: { 'Authorization': `Bearer ${haDevice.token}` },
          timeout: 5000
        });
        if (res.ok) {
          const data = await res.json();
          state = parseGridState(data.state);
        }
      } catch (e) { /* silent */ }
    }
  }

  if (state === null) return;
  const last = db.prepare('SELECT state FROM grid_status ORDER BY timestamp DESC LIMIT 1').get();
  if (!last || last.state !== state) {
    db.prepare('INSERT INTO grid_status (timestamp, state) VALUES (?, ?)').run(now, state);
    logger.info(`Grid state changed to ${state ? 'ON' : 'OFF'}`);
  }
}

function getGridStateAt(timestamp) {
  const db = getDb();
  const row = db.prepare('SELECT state FROM grid_status WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(timestamp);
  return row ? row.state : 0;
}

async function getCurrentGridStatus() {
  const gridMetric = getConfig('grid_status_entity');
  if (!gridMetric) return { configured: false };
  const db = getDb();

  // Check latest_metrics first
  const metricRow = db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get(gridMetric);
  let current;
  if (metricRow && metricRow.value !== null && metricRow.value !== undefined) {
    current = parseGridState(metricRow.value);
  } else {
    // Fall back to HA
    const haDevices = JSON.parse(getConfig('ha_devices') || '[]');
    const haDevice = haDevices.find(d => d.enabled);
    if (!haDevice) return { configured: false };
    try {
      const rawState = await fetch(`${haDevice.url}/api/states/${gridMetric}`, {
        headers: { 'Authorization': `Bearer ${haDevice.token}` },
        timeout: 5000
      }).then(r => r.json()).then(d => d.state).catch(() => 0);
      current = parseGridState(rawState);
    } catch { return { configured: false }; }
  }

  const lastOn = db.prepare("SELECT timestamp FROM grid_status WHERE state = 1 ORDER BY timestamp DESC LIMIT 1").get();
  const lastOff = db.prepare("SELECT timestamp FROM grid_status WHERE state = 0 ORDER BY timestamp DESC LIMIT 1").get();
  return {
    configured: true,
    current: current === 1,
    lastOn: lastOn ? lastOn.timestamp * 1000 : null,
    lastOff: lastOff ? lastOff.timestamp * 1000 : null
  };
}

async function getGridHours(period) {
  const db = getDb();
  const now = new Date();
  let start, end;
  if (period === 'day') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === 'week') {
    const day = now.getDay();
    const diff = (day === 0 ? 6 : day - 1);
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === 'year') {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else throw new Error('Invalid period');

  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000);
  const currentUnix = Math.floor(now.getTime() / 1000);
  const effectiveEndUnix = Math.min(endUnix, currentUnix);

  // Use current state as initial if no history exists
  let initialState = getGridStateAt(startUnix);
  const anyRows = db.prepare('SELECT COUNT(*) as c FROM grid_status WHERE timestamp < ?').get(startUnix);
  if (!anyRows || anyRows.c === 0) {
    const status = await getCurrentGridStatus();
    initialState = status.current ? 1 : 0;
  }
  const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, effectiveEndUnix);
  let hours = 0, lastState = initialState, lastTime = startUnix;
  for (const row of rows) {
    if (lastState === 1) hours += (row.timestamp - lastTime) / 3600;
    lastState = row.state;
    lastTime = row.timestamp;
  }
  if (lastState === 1) hours += (effectiveEndUnix - lastTime) / 3600;
  return Math.round(hours * 10) / 10;
}

async function getGridTimeline(period = '24h') {
  const db = getDb();
  const entity = getConfig('grid_status_entity');
  if (!entity) return { configured: false, segments: [] };
  const now = new Date();
  let start, end;
  if (period === '24h') {
    end = now;
    start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  } else if (period === 'day') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === 'week') {
    const day = now.getDay();
    const diff = (day === 0 ? 6 : day - 1);
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === 'year') {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else throw new Error('Invalid period');

  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000);
  const currentUnix = Math.floor(now.getTime() / 1000);
  const effectiveEnd = Math.min(endUnix, currentUnix);

  let initialState = getGridStateAt(startUnix);
  const anyRows = db.prepare('SELECT COUNT(*) as c FROM grid_status WHERE timestamp < ?').get(startUnix);
  if (!anyRows || anyRows.c === 0) {
    const status = await getCurrentGridStatus();
    initialState = status.current ? 1 : 0;
  }
  const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, effectiveEnd);
  const segments = [];
  let lastState = initialState, lastTime = startUnix;
  for (const row of rows) {
    if (row.timestamp > lastTime) {
      segments.push({ start: lastTime, end: row.timestamp, state: lastState });
      lastState = row.state;
      lastTime = row.timestamp;
    } else { lastState = row.state; }
  }
  if (lastTime < effectiveEnd) segments.push({ start: lastTime, end: effectiveEnd, state: lastState });

  return {
    configured: true,
    period,
    segments: segments.map(s => ({ start: s.start * 1000, end: s.end * 1000, state: s.state })),
    windowStart: start.getTime(),
    windowEnd: effectiveEnd * 1000
  };
}

module.exports = { pollGridStatus, getCurrentGridStatus, getGridHours, getGridTimeline };
