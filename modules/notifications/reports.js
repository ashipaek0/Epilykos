'use strict';
/**
 * modules/notifications/reports.js — text reports for scheduled rules and
 * Telegram commands: the day's energy summary, the solar forecast, and a
 * live status snapshot. Each returns { title, body, data }.
 *
 * Reads the same stores as the dashboard (daily snapshots, grid_status,
 * latest_metrics via role_metrics, the forecast cache) — no new bookkeeping.
 */

const { getConfig, getDb, flushMetrics } = require('../database');
const { localDateString } = require('../localTime');

function round(n, d = 1) {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
}
function kwh(n) { return `${round(n, n >= 100 ? 0 : 1)} kWh`; }
function hm(seconds) {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Local date string `offset` days from today (−1 yesterday, +1 tomorrow). */
function dayString(offset = 0, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
  return localDateString(d);
}
function dayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { start: Math.floor(new Date(y, m - 1, d).getTime() / 1000), end: Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000) - 1 };
}
function dayLabel(dateStr) {
  if (dateStr === dayString(0)) return 'Today';
  if (dateStr === dayString(-1)) return 'Yesterday';
  if (dateStr === dayString(1)) return 'Tomorrow';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

/** Seconds the grid was ON between start and end (unix s), from grid_status changes. */
function gridOnSeconds(db, start, end) {
  const before = db.prepare('SELECT state FROM grid_status WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(start);
  const rows = db.prepare('SELECT timestamp, state FROM grid_status WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(start, end);
  if (!before && !rows.length) return null;
  let on = 0, state = before ? before.state : rows[0].state, t = before ? start : rows[0].timestamp;
  for (const r of rows) {
    if (state === 1) on += r.timestamp - t;
    state = r.state; t = r.timestamp;
  }
  if (state === 1) on += Math.min(end, Math.floor(Date.now() / 1000)) - t;
  return Math.max(0, on);
}

function readDayTotals(db, dateStr) {
  const { readDailySnapshots } = require('../timeseriesReader');
  const { start, end } = dayBounds(dateStr);
  const rows = readDailySnapshots(db, { from: start, to: end, toInclusive: true, fields: ['daily_consumption', 'daily_solar', 'daily_battery_charge', 'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export', 'daily_generator'] });
  return rows.find(r => r.day === dateStr) || null;
}

/** Energy summary for `which` ('today' | 'yesterday'). */
async function daySummary(which = 'today') {
  try { flushMetrics(); } catch (_) { /* best effort */ }
  const db = getDb();
  const date = dayString(which === 'yesterday' ? -1 : 0);
  const t = readDayTotals(db, date) || {};
  const lines = [];
  const solar = t.daily_solar || 0;
  if (which !== 'yesterday') {
    try {
      const { computeTodaySolar } = require('../solar');
      const live = computeTodaySolar();
      if (Number.isFinite(live) && live > solar) t.daily_solar = live;
    } catch (_) { /* snapshot value stands */ }
  }
  lines.push(`☀️ Solar: ${kwh(t.daily_solar || solar)}`);
  if (t.daily_consumption) lines.push(`🏠 Used: ${kwh(t.daily_consumption)}`);
  if (t.daily_grid_import || t.daily_grid_export) lines.push(`🔌 Grid: ${kwh(t.daily_grid_import || 0)} in, ${kwh(t.daily_grid_export || 0)} out`);
  if (t.daily_battery_charge || t.daily_battery_discharge) lines.push(`🔋 Battery: ${kwh(t.daily_battery_charge || 0)} charged, ${kwh(t.daily_battery_discharge || 0)} used`);
  if (t.daily_generator) lines.push(`⛽ Generator: ${kwh(t.daily_generator)}`);
  if (getConfig('grid_status_entity')) {
    const { start, end } = dayBounds(date);
    const on = gridOnSeconds(db, start, end);
    if (on !== null) {
      const span = Math.min(end, Math.floor(Date.now() / 1000)) - start;
      lines.push(`⚡ Grid available: ${hm(on)}${span > 0 ? ` (${Math.round(on / span * 100)}%)` : ''}`);
    }
  }
  if (which !== 'yesterday') {
    try {
      const { getSavings } = require('../savings');
      const s = await getSavings();
      if (s && Number(s.today) > 0) lines.push(`💰 Saved: ${s.currency || ''}${round(s.today, 2)}`);
    } catch (_) { /* savings not set up */ }
  }
  const hasTotals = ['daily_solar', 'daily_consumption', 'daily_grid_import', 'daily_grid_export', 'daily_battery_charge', 'daily_battery_discharge', 'daily_generator'].some(k => t[k] > 0);
  if (!hasTotals) lines.splice(0, 1, 'No energy totals recorded for this day yet.');
  return { title: `${dayLabel(date)}'s energy`, body: lines.join('\n'), data: { date, ...t } };
}

/** Solar forecast for `which` ('today' | 'tomorrow'). data.kwh is null when unavailable. */
async function forecastReport(which = 'tomorrow') {
  const date = dayString(which === 'today' ? 0 : 1);
  let forecast;
  try { forecast = await require('../solar').getSolarForecast(); } catch (e) { forecast = { error: e.message }; }
  if (!forecast || forecast.error) {
    return { title: `${dayLabel(date)}'s solar forecast`, body: `No forecast available${forecast && forecast.error ? `: ${forecast.error}` : ''}.`, data: { date, kwh: null } };
  }
  const day = (forecast.daily || []).find(d => d.date === date);
  if (!day) return { title: `${dayLabel(date)}'s solar forecast`, body: 'The forecast does not cover this day yet.', data: { date, kwh: null } };
  const lines = [`☀️ Expected: ${kwh(day.total_kwh)} (peak ${round(day.peak_kw, 1)} kW)`];
  // Compare with the last 7 days' actual generation.
  let avg = null;
  try {
    const db = getDb();
    const { readDailySnapshots } = require('../timeseriesReader');
    const from = dayBounds(dayString(-7)).start, to = dayBounds(dayString(-1)).end;
    const rows = readDailySnapshots(db, { from, to, toInclusive: true, fields: ['daily_solar'] }).filter(r => r.daily_solar > 0);
    if (rows.length >= 3) avg = rows.reduce((a, r) => a + r.daily_solar, 0) / rows.length;
  } catch (_) { /* no history yet */ }
  if (avg) {
    const pct = Math.round(day.total_kwh / avg * 100);
    lines.push(`📊 ${pct}% of your 7-day average (${kwh(avg)})`);
  }
  if (which === 'today' && day.actual_so_far != null) lines.push(`So far: ${kwh(day.actual_so_far)}`);
  if (forecast.source_label) lines.push(`Source: ${forecast.source_label}`);
  return { title: `${dayLabel(date)}'s solar forecast`, body: lines.join('\n'), data: { date, kwh: day.total_kwh, peak_kw: day.peak_kw, average_kwh: avg } };
}

function roleMetrics() {
  try { return JSON.parse(getConfig('role_metrics') || '{}') || {}; } catch (_) { return {}; }
}

function fmtPower(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) >= 1000 ? `${round(n / 1000, 2)} kW` : `${Math.round(n)} W`;
}

/** Live snapshot: power flows, battery, grid, data age. */
async function statusReport() {
  try { flushMetrics(); } catch (_) { /* best effort */ }
  const db = getDb();
  const roles = roleMetrics();
  const read = (name) => (name ? db.prepare('SELECT value, value_text, unit, timestamp FROM latest_metrics WHERE metric = ?').get(name) : null);
  const lines = [];
  let newest = 0;
  const add = (label, role, kind) => {
    const r = read(roles[role]);
    if (!r) return;
    newest = Math.max(newest, r.timestamp || 0);
    const v = r.value != null ? r.value : r.value_text;
    if (v == null) return;
    if (kind === 'power') {
      const unit = String(r.unit || '').toLowerCase();
      const p = fmtPower(unit === 'kw' ? Number(v) * 1000 : v);
      if (p) lines.push(`${label}: ${p}`);
    } else if (kind === 'pct') lines.push(`${label}: ${round(v, 0)}%`);
    else lines.push(`${label}: ${v}${r.unit ? ' ' + r.unit : ''}`);
  };
  add('☀️ Solar', 'solar', 'power');
  add('🏠 Load', 'consumption', 'power');
  add('🔋 Battery', 'battery_soc', 'pct');
  add('🔋 Charging', 'battery_charge', 'power');
  add('🔋 Discharging', 'battery_discharge', 'power');
  add('🔌 Grid import', 'grid_import', 'power');
  add('🔌 Grid export', 'grid_export', 'power');
  try {
    const g = await require('../grid').getCurrentGridStatus();
    if (g && g.configured && g.available) lines.push(`⚡ Grid: ${g.current ? 'on' : 'OFF'}`);
  } catch (_) { /* grid not set up */ }
  if (!lines.length) lines.push('No live values yet. Map the solar, load and battery roles in Settings → Metrics.');
  if (newest) {
    const age = Math.floor(Date.now() / 1000) - newest;
    lines.push(age > 300 ? `⚠️ Last update ${hm(age)} ago` : `Updated ${age < 60 ? 'just now' : hm(age) + ' ago'}`);
  }
  return { title: 'Epilykos status', body: lines.join('\n'), data: {} };
}

const REPORTS = {
  day_summary: { label: 'Daily energy summary', days: ['today', 'yesterday'], build: daySummary },
  forecast: { label: 'Solar forecast', days: ['tomorrow', 'today'], build: forecastReport },
  status: { label: 'Current status', days: [], build: () => statusReport() },
};

module.exports = { REPORTS, daySummary, forecastReport, statusReport, gridOnSeconds, dayString, dayBounds, hm };
