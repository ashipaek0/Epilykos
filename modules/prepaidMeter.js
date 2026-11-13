'use strict';
/**
 * Prepaid meter: a running balance of the units (kWh) left on a prepaid electricity meter.
 *
 * Epilykos counts the energy drawn from the grid (the daily grid import counter, or the grid import power where there is
 * no counter) and takes it off the balance. Two things are entered by hand, both in Settings or on the Prepaid meter card:
 *   Recharge          the units a token gave, and (optionally) what was paid, which gives the price per unit;
 *   Correct balance   what the meter shows now. It sets the balance to that number at any time, and (if asked) learns from
 *                     the difference: a factor between what Epilykos measures and what the meter counts, so later
 *                     estimates drift less.
 * One unit is one kWh. The last entry can be undone. Nothing is counted, shown or stored until it is switched on.
 *
 * The balance, the days left (at the average of the last 7 days) and a few more figures are published as metrics
 * (`prepaid_*`) unless the balance is set to be private (signed-in users only), in which case they are not published and
 * the cards ask the server, which answers only a signed-in user. A low balance and an empty meter raise the events
 * `prepaid.low` and `prepaid.out` for notification rules.
 *
 * The logic is plain functions on a state object (tested without a database); `tick`, `view` and the entry points wrap
 * them with storage.
 *
 * @module prepaidMeter
 */
const crypto = require('crypto');
const { localDateString } = require('./localTime');
const { logger } = require('./logger');

const CONFIG_KEY = 'prepaid_meter';        // { settings, state }: small, written whenever the balance moves
const LEDGER_KEY = 'prepaid_ledger';       // the entries: written only when one is added or undone
const MAX_LEDGER = 200;
const MAX_STEP_S = 600;                    // power mode: a longer gap between polls counts as 10 minutes
const AVG_DAYS = 7;
const MAX_UNITS = 100000;
const FACTOR_RANGE = [0.5, 1.5];
const METRICS = Object.freeze({ balance: 'prepaid_balance', daysLeft: 'prepaid_days_left', usedSinceRecharge: 'prepaid_used_since_recharge', costPerUnit: 'prepaid_cost_per_unit' });

const round = (n, d = 3) => { const f = Math.pow(10, d); return Math.round(n * f) / f; };
const finite = v => v !== '' && v != null && Number.isFinite(Number(v));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ── Settings ─────────────────────────────────────────────────────────────

/** The valid settings: off by default, thresholds optional (null = no warning of that kind). */
function cleanSettings(raw = {}) {
  const positive = v => (finite(v) && Number(v) > 0 ? round(Number(v), 2) : null);
  return { enabled: raw.enabled === true, warnKwh: positive(raw.warnKwh), warnDays: positive(raw.warnDays), privateBalance: raw.privateBalance === true };
}

function emptyState() {
  return { started: false, balance: 0, factor: 1, usedToday: 0, usedDay: '', usedSinceRecharge: 0, fullAt: 0, cal: { start: null, recharged: 0, measured: 0 }, last: { counter: null, day: '', ts: 0 }, alerted: '' };
}

/** A state read back from storage, with anything missing or wrong put right. */
function cleanState(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  s.started = raw.started === true;
  for (const k of ['balance', 'usedToday', 'usedSinceRecharge', 'fullAt']) if (finite(raw[k])) s[k] = Math.max(0, Number(raw[k]));
  if (finite(raw.factor)) s.factor = clamp(Number(raw.factor), FACTOR_RANGE[0], FACTOR_RANGE[1]);
  s.usedDay = typeof raw.usedDay === 'string' ? raw.usedDay : '';
  if (raw.cal && typeof raw.cal === 'object') s.cal = { start: finite(raw.cal.start) ? Number(raw.cal.start) : null, recharged: finite(raw.cal.recharged) ? Number(raw.cal.recharged) : 0, measured: finite(raw.cal.measured) ? Number(raw.cal.measured) : 0 };
  if (raw.last && typeof raw.last === 'object') s.last = { counter: finite(raw.last.counter) ? Number(raw.last.counter) : null, day: typeof raw.last.day === 'string' ? raw.last.day : '', ts: finite(raw.last.ts) ? Number(raw.last.ts) : 0 };
  s.alerted = ['low', 'out'].includes(raw.alerted) ? raw.alerted : '';
  return s;
}

// ── Counting the energy drawn ────────────────────────────────────────────

/**
 * The energy drawn since the previous reading of a daily counter (a total that counts up through the day and starts again
 * at midnight): the difference on the same day; the whole value on a new day or when it went back (the counter was reset).
 * The first reading has nothing before it, so it counts for nothing.
 */
function counterDelta(last, counter, day) {
  if (!finite(counter) || Number(counter) < 0) return 0;
  const now = Number(counter);
  if (last.counter === null || !last.day) return 0;
  if (day !== last.day) return now;
  return now >= last.counter ? now - last.counter : now;
}

/** Take `kwh` (as measured) off the balance, with the learned factor, and count it for today. Returns the effective kWh. */
function applyUsage(state, kwh, day) {
  if (!(kwh > 0)) return 0;
  if (state.usedDay !== day) { state.usedDay = day; state.usedToday = 0; }
  const eff = kwh * state.factor;
  state.balance = Math.max(0, state.balance - eff);
  state.usedToday += eff;
  state.usedSinceRecharge += eff;
  state.cal.measured += kwh;
  return eff;
}

// ── Entries ──────────────────────────────────────────────────────────────

const snapshot = state => ({ started: state.started, balance: state.balance, factor: state.factor, fullAt: state.fullAt, usedSinceRecharge: state.usedSinceRecharge, cal: { ...state.cal } });
const newId = () => crypto.randomBytes(6).toString('hex');

/** Add the units of a recharge (and what was paid, optionally). Returns { entry } or { error }. */
function recharge(state, units, amount, now) {
  if (!state.started) return { error: 'Enter what the meter shows first, so there is a balance to add to.' };
  if (!finite(units) || Number(units) <= 0 || Number(units) > MAX_UNITS) return { error: 'The units on the token must be more than 0.' };
  const u = round(Number(units), 3);
  const paid = finite(amount) && Number(amount) > 0 ? round(Number(amount), 2) : null;
  const before = snapshot(state);
  state.balance += u;
  state.fullAt = state.balance;
  state.usedSinceRecharge = 0;
  state.cal.recharged += u;
  state.alerted = '';
  return { entry: { id: newId(), ts: now, type: 'recharge', units: u, amount: paid, price: paid ? round(paid / u, 4) : null, delta: u, before } };
}

/**
 * Set the balance to what the meter shows, at any time. With `learn`, the difference also tunes the factor (what the meter
 * counts for each kWh Epilykos measures), once there are at least 2 kWh measured since the last correction to learn from.
 */
function correct(state, actual, learn, now) {
  if (!finite(actual) || Number(actual) < 0 || Number(actual) > MAX_UNITS) return { error: 'The meter reading must be 0 or more.' };
  const a = round(Number(actual), 3);
  const before = snapshot(state);
  const est = state.started ? state.balance : null;
  let used = null, learned = false;
  if (state.started && state.cal.start !== null) used = state.cal.start + state.cal.recharged - a;
  if (learn && state.started && used !== null && used > 0 && state.cal.measured >= 2) {
    state.factor = round(clamp((state.factor + clamp(used / state.cal.measured, FACTOR_RANGE[0], FACTOR_RANGE[1])) / 2, FACTOR_RANGE[0], FACTOR_RANGE[1]), 4);
    learned = true;
  }
  const error = est === null ? null : round(est - a, 3);
  state.started = true;
  state.balance = a;
  state.fullAt = Math.max(state.fullAt, a);
  state.cal = { start: a, recharged: 0, measured: 0 };
  state.alerted = '';
  return { entry: { id: newId(), ts: now, type: est === null ? 'start' : 'check', units: a, est, errorKwh: error, errorPct: error !== null && used > 0.5 ? round(error / used * 100, 1) : null, learned, delta: est === null ? a : round(a - est, 3), before } };
}

/**
 * Undo the latest entry: the balance moves back by what it added, and what it changed is restored. What was measured since
 * the entry still counts (the usage after a recharge, the energy measured since a correction).
 */
function undo(state, entry) {
  if (!entry) return { error: 'There is nothing to undo.' };
  const b = entry.before || {};
  const since = state.cal.measured, usedSince = state.usedSinceRecharge;
  state.balance = Math.max(0, state.balance - (Number(entry.delta) || 0));
  if (b.started === false) { Object.assign(state, { started: false, balance: 0, fullAt: 0, usedSinceRecharge: 0, cal: { start: null, recharged: 0, measured: 0 } }); state.alerted = ''; return { ok: true }; }
  if (finite(b.factor)) state.factor = Number(b.factor);
  if (finite(b.fullAt)) state.fullAt = Number(b.fullAt);
  if (entry.type === 'recharge' && finite(b.usedSinceRecharge)) state.usedSinceRecharge = Number(b.usedSinceRecharge) + usedSince;
  if (b.cal) state.cal = { start: b.cal.start, recharged: b.cal.recharged, measured: entry.type === 'check' ? (b.cal.measured || 0) + since : since };
  state.alerted = '';
  return { ok: true };
}

// ── What the cards and metrics show ──────────────────────────────────────

/** 'ok', 'low' (at or under a warning level you set) or 'out'; 'unknown' before the first reading. */
function levelOf(state, settings, daysLeft) {
  if (!state.started) return 'unknown';
  if (state.balance <= 0) return 'out';
  if (settings.warnKwh !== null && state.balance <= settings.warnKwh) return 'low';
  if (settings.warnDays !== null && daysLeft !== null && daysLeft <= settings.warnDays) return 'low';
  return 'ok';
}

/** Everything a card shows. `avgDaily` is the average kWh a day (as measured), or null when there is not enough history. */
function summarize(state, settings, ledger, avgDaily, now) {
  const avg = avgDaily !== null && avgDaily > 0 ? round(avgDaily * state.factor, 3) : null;
  const daysLeft = state.started && avg ? round(state.balance / avg, 1) : null;
  const level = levelOf(state, settings, daysLeft);
  const lastRecharge = [...ledger].reverse().find(e => e.type === 'recharge') || null;
  const lastCheck = [...ledger].reverse().find(e => e.type === 'check') || null;
  return {
    enabled: true, started: state.started, unit: 'kWh', level,
    balance: state.started ? round(state.balance, 2) : null, daysLeft,
    emptyOn: daysLeft !== null && state.balance > 0 ? new Date((now + daysLeft * 86400) * 1000).toISOString() : null,
    avgDaily: avg, usedToday: state.usedDay === localDateString(new Date(now * 1000)) ? round(state.usedToday, 2) : 0, usedSinceRecharge: round(state.usedSinceRecharge, 2),
    fill: state.started && state.fullAt > 0 ? round(clamp(state.balance / state.fullAt, 0, 1), 3) : 0,
    lastRecharge: lastRecharge ? { ts: lastRecharge.ts, units: lastRecharge.units, amount: lastRecharge.amount, price: lastRecharge.price } : null,
    lastCheck: lastCheck ? { ts: lastCheck.ts, errorKwh: lastCheck.errorKwh, errorPct: lastCheck.errorPct, learned: lastCheck.learned } : null,
    factor: round(state.factor, 3), warn: { kwh: settings.warnKwh, days: settings.warnDays }
  };
}

// ── Storage ──────────────────────────────────────────────────────────────

const db = () => require('./database');
function readJson(key, fallback) { try { const v = JSON.parse(db().getConfig(key) || 'null'); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } }

function load() {
  const stored = readJson(CONFIG_KEY, {});
  const ledger = readJson(LEDGER_KEY, []);
  return { settings: cleanSettings(stored.settings), state: cleanState(stored.state), ledger: Array.isArray(ledger) ? ledger.filter(e => e && typeof e === 'object').slice(-MAX_LEDGER) : [] };
}
const saveState = m => db().setConfig(CONFIG_KEY, JSON.stringify({ settings: m.settings, state: m.state }));
const saveLedger = m => db().setConfig(LEDGER_KEY, JSON.stringify(m.ledger.slice(-MAX_LEDGER)));

function roleMetric(role) {
  try { const roles = JSON.parse(db().getConfig('role_metrics') || '{}') || {}; return String(roles[role] || '').trim() || role; } catch (e) { return role; }
}

/** Which energy readings the count uses: the daily grid import counter, else the grid import power. */
function sourceOf(read) {
  const counter = roleMetric('daily_grid_import'), power = roleMetric('grid_import');
  const c = read(counter), p = read(power);
  if (c && finite(c.value)) return { mode: 'counter', metric: counter, row: c };
  if (p && finite(p.value)) return { mode: 'power', metric: power, row: p };
  return { mode: 'none', metric: counter, row: null };
}
const latest = name => { try { return db().getDb().prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get(name) || null; } catch (e) { return null; } };

/** The average kWh a day drawn from the grid over the last days, as measured, or null. */
/** The money symbol set in Settings > Prices and savings. */
function currencySymbol() { try { return String(require('./solarValue').savingsSettings().currency || ''); } catch (e) { return ''; } }

function averageDaily(now) {
  try {
    const { averagePerDay } = require('./dailyAverages');
    const r = averagePerDay(db().getDb(), { inputs: [roleMetric('daily_grid_import')], daily: 'total', days: AVG_DAYS }, new Date(now * 1000));
    return r && Number.isFinite(r.value) ? r.value : null;
  } catch (e) { return null; }
}

function publish(m, view, now) {
  if (m.settings.privateBalance || !m.state.started) return;
  try {
    const d = db();
    d.queueMetricValue(METRICS.balance, view.balance, now, 'kWh');
    if (view.daysLeft !== null) d.queueMetricValue(METRICS.daysLeft, view.daysLeft, now, 'd');
    d.queueMetricValue(METRICS.usedSinceRecharge, view.usedSinceRecharge, now, 'kWh');
    if (view.lastRecharge && view.lastRecharge.price) d.queueMetricValue(METRICS.costPerUnit, view.lastRecharge.price, now, '');
  } catch (e) { logger.debug(`[prepaid] could not publish the balance: ${e.message}`); }
}

function raiseEvents(m, view, now) {
  const level = view.level;
  if (level === 'ok') { m.state.alerted = ''; return; }
  if (level === 'unknown') return;
  const order = { '': 0, low: 1, out: 2 };
  if (order[level] <= order[m.state.alerted]) return;
  m.state.alerted = level;
  try {
    const { emitEvent } = require('./notifications/events');
    const days = view.daysLeft !== null ? `, about ${view.daysLeft} day${view.daysLeft === 1 ? '' : 's'} at ${view.avgDaily} kWh a day` : '';
    if (level === 'out') emitEvent('prepaid.out', { message: 'The prepaid meter is out of units. Recharge to restore power.', subject: 'prepaid', data: { balance: 0 }, timestamp: now });
    else emitEvent('prepaid.low', { message: `${view.balance} kWh left on the prepaid meter${days}. Recharge soon.`, subject: 'prepaid', data: { balance: view.balance, daysLeft: view.daysLeft }, timestamp: now });
  } catch (e) { logger.debug(`[prepaid] could not raise the event: ${e.message}`); }
}

let lastPersist = 0;
const PERSIST_EVERY_S = 60;

/** One poll cycle: take the energy drawn since the last one off the balance, publish, and raise a low or empty event. */
function tick(now = Math.floor(Date.now() / 1000)) {
  const m = load();
  if (!m.settings.enabled) return { enabled: false };
  try { db().flushMetrics(); } catch (e) { /* the readings may be a poll old */ }
  const src = sourceOf(latest);
  const day = localDateString(new Date(now * 1000));
  let kwh = 0;
  if (src.mode === 'counter') { kwh = counterDelta(m.state.last, Number(src.row.value), day); m.state.last = { counter: Number(src.row.value), day, ts: now }; }
  else if (src.mode === 'power') {
    const dt = m.state.last.ts && m.state.last.counter === null ? clamp(now - m.state.last.ts, 0, MAX_STEP_S) : 0;   // the first reading in this mode has nothing before it
    kwh = Math.max(0, Number(src.row.value)) / 1000 * dt / 3600; m.state.last = { counter: null, day, ts: now };
  }
  if (m.state.started) applyUsage(m.state, kwh, day);
  const view = summarize(m.state, m.settings, m.ledger, averageDaily(now), now);
  if (m.state.started) { publish(m, view, now); raiseEvents(m, view, now); }
  if (kwh > 0 || now - lastPersist >= PERSIST_EVERY_S) { saveState(m); lastPersist = now; }
  return { enabled: true, mode: src.mode, kwh };
}

/** What the API returns: nothing for a viewer when the balance is private; the entries and the settings only for a signed-in user. */
function view({ authed = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const m = load();
  if (!m.settings.enabled) return { enabled: false, canEdit: authed };
  if (m.settings.privateBalance && !authed) return { enabled: true, hidden: true };
  const src = sourceOf(latest);
  const out = summarize(m.state, m.settings, m.ledger, averageDaily(now), now);
  out.canEdit = authed;
  out.currency = currencySymbol();
  out.source = src.mode;
  out.private = m.settings.privateBalance;
  if (src.mode === 'none') out.problem = 'No grid energy reading to count: map a daily grid import metric.';
  if (authed) out.ledger = m.ledger.slice(-30).reverse().map(({ before, ...rest }) => rest);
  return out;
}

function settingsView() {
  const m = load();
  const src = sourceOf(latest);
  return { ...m.settings, source: src.mode, metric: src.metric, started: m.state.started };
}

function saveSettings(raw) {
  const m = load();
  m.settings = cleanSettings({ ...m.settings, ...raw });
  saveState(m);
  return settingsView();
}

function mutate(fn) {
  const m = load();
  if (!m.settings.enabled) return { error: 'Prepaid meter tracking is switched off in Settings.' };
  const r = fn(m);
  if (r.error) return r;
  saveState(m); saveLedger(m);
  return { ok: true, view: view({ authed: true }) };
}

const addRecharge = (units, amount, ts, now = Math.floor(Date.now() / 1000)) => mutate(m => {
  const r = recharge(m.state, units, amount, finite(ts) && Number(ts) > 0 && Number(ts) <= now ? Number(ts) : now);
  if (r.entry) m.ledger.push(r.entry);
  return r;
});
const addCorrection = (actual, learn, now = Math.floor(Date.now() / 1000)) => mutate(m => {
  const r = correct(m.state, actual, learn === true, now);
  if (r.entry) m.ledger.push(r.entry);
  return r;
});
const undoLast = () => mutate(m => {
  const entry = m.ledger[m.ledger.length - 1];
  const r = undo(m.state, entry);
  if (!r.error) m.ledger.pop();
  return r;
});

module.exports = {
  cleanSettings, cleanState, emptyState, counterDelta, applyUsage, recharge, correct, undo, levelOf, summarize,
  tick, view, settingsView, saveSettings, addRecharge, addCorrection, undoLast, METRICS, CONFIG_KEY, LEDGER_KEY, MAX_LEDGER,
  resetPrepaidMeter: () => { lastPersist = 0; }
};
