/**
 * Generator Status Tracking
 *
 * The generator card's counterpart of modules/grid.js: 1 = generator running,
 * 0 = stopped. State changes go in the generator_status table, and the run
 * hours, hours per day and 24-hour timeline are read from it with the same
 * queries the grid uses.
 *
 * "Running" comes from, in this order:
 *  1. the generator_status_entity setting: a metric that is ON while the
 *     generator runs (a switch, a binary sensor, a 0/1 flag);
 *  2. otherwise the generator power role: running while it is above
 *     GENERATOR_ON_WATTS. This needs no extra setting for inverters that
 *     report the power taken from the generator input.
 *
 * @module generator
 */
const { logger } = require('./logger');
const { getConfig, getDb, flushMetrics } = require('./database');
const { parseGridState } = require('./utils');
const { emitEvent } = require('./notifications/events');
const { hoursOn, getGridDailyHours, timelineOf } = require('./grid');

const TABLE = 'generator_status';
/** Power above this counts as running: a generator input idles at a few watts. */
const GENERATOR_ON_WATTS = 20;
/** A change is recorded only after the previous one is at least this old. */
const MIN_DWELL_S = 60;

function fmtDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function roleMetric() {
  try { return String((JSON.parse(getConfig('role_metrics') || '{}') || {}).generator || '').trim(); } catch (e) { return ''; }
}

/** Where "running" is read from, or null when nothing is set up. */
function generatorSource() {
  const status = String(getConfig('generator_status_entity') || '').trim();
  if (status) return { kind: 'status', metric: status };
  const power = roleMetric();
  if (power) return { kind: 'power', metric: power };
  return null;
}

/** The current state: 1 running, 0 stopped, null when it can't be told. */
function readGeneratorState(source) {
  if (!source) return null;
  flushMetrics(); // read-your-write: pollers queue their writes
  const row = getDb().prepare('SELECT value, value_text FROM latest_metrics WHERE metric = ?').get(source.metric);
  if (!row) return null;
  const raw = row.value != null ? row.value : row.value_text;
  if (raw === null || raw === undefined) return null;
  if (source.kind === 'power') {
    const w = Number(raw);
    return Number.isFinite(w) ? (w > GENERATOR_ON_WATTS ? 1 : 0) : null;
  }
  return parseGridState(raw, source.metric, () => {});
}

/** Record changes of the generator state, with the same minimum dwell as the grid. */
async function pollGeneratorStatus() {
  const source = generatorSource();
  if (!source) return;
  const state = readGeneratorState(source);
  if (state === null) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const last = db.prepare(`SELECT timestamp, state FROM ${TABLE} ORDER BY timestamp DESC LIMIT 1`).get();
  if (last && last.state === state) return;
  if (last && (now - last.timestamp) < MIN_DWELL_S) {
    logger.debug(`Generator: state change within ${MIN_DWELL_S}s dwell skipped`);
    return;
  }
  db.prepare(`INSERT INTO ${TABLE} (timestamp, state) VALUES (?, ?)`).run(now, state);
  logger.info(`Generator ${state ? 'ON' : 'OFF'} at ${new Date(now * 1000).toISOString()}`);
  // The first row ever is the initial reading, not a start or stop.
  if (last) {
    emitEvent(state ? 'generator.on' : 'generator.off', {
      message: state ? `The generator started (it had been off for ${fmtDuration(now - last.timestamp)}).` : `The generator stopped after running ${fmtDuration(now - last.timestamp)}.`,
      data: { previousDurationS: now - last.timestamp },
    });
  }
}

/** The current state and the last start / stop, in the grid's shape. */
async function getCurrentGeneratorStatus() {
  const source = generatorSource();
  if (!source) return { configured: false, available: false };
  const state = readGeneratorState(source);
  const row = getDb().prepare(`SELECT
    (SELECT state FROM ${TABLE} ORDER BY timestamp DESC LIMIT 1) AS last_change_state,
    MAX(CASE WHEN state = 1 THEN timestamp END) AS last_on,
    MAX(CASE WHEN state = 0 THEN timestamp END) AS last_off,
    MAX(timestamp) AS last_change_ts
  FROM ${TABLE}`).get();
  return {
    configured: true,
    available: state !== null,
    current: state === 1,
    source: source.kind,
    lastOn: row.last_on ? row.last_on * 1000 : null,
    lastOff: row.last_off ? row.last_off * 1000 : null,
    lastChange: row.last_change_ts ? { time: row.last_change_ts * 1000, state: row.last_change_state } : null,
  };
}

/** Hours the generator ran in a period ('day', 'week', 'month', 'year', 'all'). */
async function getGeneratorHours(period) {
  return hoursOn(TABLE, period);
}

/** Run hours for each of the last `days` local days, oldest first. */
function getGeneratorDailyHours(days = 30) {
  return getGridDailyHours(days, TABLE);
}

async function getGeneratorTimeline() {
  if (!generatorSource()) return { configured: false, available: false, segments: [] };
  return timelineOf(TABLE);
}

module.exports = {
  pollGeneratorStatus, getCurrentGeneratorStatus, getGeneratorHours, getGeneratorDailyHours, getGeneratorTimeline,
  generatorSource, GENERATOR_ON_WATTS,
};
