'use strict';
/**
 * test/forecast-live-update.test.js — forecast and PV Today cards update with the live cards.
 *
 * The server pushes the energy produced today in the dashboard state (solarToday), from a
 * fresh figure each cycle, as a delta only when it changes. The cards show it from the push
 * with no request, and fetch the forecast curve and weather only on a timer, when a card is
 * new, or when the day changes.
 */
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  // ── Server: solarToday in the state, fresh, and quiet when unchanged ──────────
  process.env.ENC_KEY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-fc-')), 'key');
  const { initializeDatabase, getDb, setConfig } = require('../modules/database');
  initializeDatabase();
  const db = getDb();
  const put = (metric, value) => db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, value_type, timestamp, unit) VALUES (?, ?, ?, ?, ?)').run(metric, value, 'number', Math.floor(Date.now() / 1000), 'kWh');
  setConfig('savings_solar_metric', 'pv_today_kwh');
  put('pv_today_kwh', 4.2);

  const { buildDashboardState } = require('../routes/metrics');
  const { computeTodaySolar } = require('../modules/solar');
  const { localDateString } = require('../modules/localTime');
  let state = await buildDashboardState();
  assert.deepEqual(state.solarToday, { kwh: 4.2, date: localDateString() }, 'the state carries today\'s energy and its date, nothing that changes every cycle');
  assert.equal(Object.keys(state.solarToday).length, 2);

  put('pv_today_kwh', 5.1);
  assert.equal(computeTodaySolar(), 4.2, 'the cached figure is up to 30 s old');
  assert.equal(computeTodaySolar({ fresh: true }), 5.1, 'fresh skips the cache');
  put('pv_today_kwh', 6.3);
  state = await buildDashboardState();
  assert.equal(state.solarToday.kwh, 6.3, 'each state build uses a fresh figure, not the 30 s cache');
  console.log('ok - the state carries a fresh figure for today');

  // The server sends a delta, and nothing when the figure has not moved.
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const head = 'function computeDelta(current, previous)';
  let i = SRC.indexOf('{', SRC.indexOf(head)), depth = 0, j = i;
  for (; j < SRC.length; j++) { if (SRC[j] === '{') depth++; else if (SRC[j] === '}' && --depth === 0) break; }
  const computeDelta = eval(SRC.slice(SRC.indexOf(head), j + 1) + '\ncomputeDelta');
  const a = { current: { x: 1 }, solarToday: { kwh: 6.3, date: '2026-11-02' } };
  assert.deepEqual(computeDelta(a, JSON.parse(JSON.stringify(a))), {}, 'an unchanged figure is an empty delta');
  assert.deepEqual(computeDelta({ ...a, solarToday: { kwh: 6.4, date: '2026-11-02' } }, a), { solarToday: { kwh: 6.4 } });
  console.log('ok - an unchanged figure adds nothing to a push; a change is a small delta');

  // The page applies a delta that carries only solarToday without a full redraw.
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public/js/dashboard.js'), 'utf8');
  assert.match(dash, /PARTIAL_RENDER_KEYS = new Set\(\[[^\]]*'solarToday'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public/js/cards-update.js'), 'utf8'), /updateForecast\(state\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public/js/theme.js'), 'utf8'), /updateForecast\(undefined, \{ force: true \}\)/);
  console.log('ok - a solarToday delta is a partial render; a theme change still redraws everything');

  // ── Page: what a push does, with a stubbed page ───────────────────────────────
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const calls = [];
  const payload = () => ({
    source: 'auto', daily: [{ date: today, total_kwh: 20, actual_so_far: 3 }],
    // Still to come today, whatever the time now (an hour from now is tomorrow late in the evening).
    hourly: [{ period_end: new Date(new Date().setHours(23, 59, 59, 0)).toISOString(), energy_kwh: 2, pv_estimate: 2 }], weather: null
  });
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => (String(url).startsWith('/api/solar-forecast') ? payload() : []) }; };

  const mk = (selectors) => {
    const text = {};
    const nodes = {};
    const node = (name) => (nodes[name] = nodes[name] || { hidden: false, style: {}, firstChild: { textContent: '' }, firstElementChild: { style: {} }, set textContent(v) { text[name] = v; }, get textContent() { return text[name] || ''; }, classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '' });
    const el = { dataset: { blockId: 'b1', source: 'auto' }, isConnected: true, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, querySelector: (s) => (selectors.includes(s) ? node(s) : null), _text: text, _nodes: nodes };
    return el;
  };
  const summary = mk(['.fc-today', '.fc-today-value', '.fc-today-sub', '.fc-today-remaining', '.fc-progress', '.fc-source']);
  const pvText = {};
  const pvIds = { 'pvt-generated-b2': 'genEl', 'pvt-remaining-b2': 'remEl', 'pvt-progress-fill-b2': 'fillEl' };
  const pv = { dataset: { blockId: 'b2', source: 'auto' }, isConnected: true, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, querySelector: () => null };
  const pvNodes = {};
  const byId = (id) => (pvIds[id] ? (pvNodes[id] = pvNodes[id] || { textContent: '', style: {} }) : null);
  let cards = [summary], pvs = [pv];
  globalThis.document = {
    documentElement: { getAttribute: () => 'light' },
    querySelector: () => null, getElementById: byId, createElement: () => ({ style: {}, classList: { add() {} } }),
    querySelectorAll: (sel) => (sel.includes('pv-today-instance') && sel.includes('forecast-banner-instance') ? [...cards, ...pvs] : sel === '.pv-today-instance' ? pvs : cards),
    addEventListener() {}, body: {}
  };
  globalThis.window = globalThis;
  const forecast = await import('../public/js/forecast.js');
  const regs = await import('../public/js/components/blockRegistry.js');
  regs.registerBlock({ id: 'b1', config: {} });
  regs.registerBlock({ id: 'b2', config: {} });

  // Make the cards look like cards on the page: forecast-info and pv-today classes.
  const origQSA = globalThis.document.querySelectorAll;
  globalThis.document.querySelectorAll = (sel) => {
    if (sel === '.forecast-banner-instance, .forecast-info-instance, .forecast-sparkline-instance, .pv-today-instance') return [...cards, ...pvs];
    if (sel === '.forecast-banner-instance, .forecast-info-instance, .forecast-sparkline-instance') return cards;
    if (sel === '.pv-today-instance') return pvs;
    return origQSA(sel);
  };

  const push = (kwh) => ({ solarToday: { kwh, date: today } });
  await forecast.updateForecast(push(3.5));
  assert.ok(calls.some(u => u.startsWith('/api/solar-forecast')), 'the first push loads the forecast');
  const firstLoadCalls = calls.length;
  assert.match(summary._text['.fc-today-sub'] || '', /3\.5 produced/, 'the first draw already shows the pushed figure, not the payload\'s older one');

  calls.length = 0;
  await forecast.updateForecast(push(4.4));
  await forecast.updateForecast(push(4.9));
  assert.equal(calls.length, 0, 'later pushes make no request');
  assert.match(summary._text['.fc-today-sub'] || '', /4\.9 produced/, 'the forecast card shows the new figure from the push');
  assert.equal(pvNodes['pvt-generated-b2'] && pvNodes['pvt-generated-b2'].textContent, '4.9 kWh', 'PV Today shows it too');
  assert.match(pvNodes['pvt-remaining-b2'].textContent, /^2\.0 kWh$/);
  console.log('ok - pushes update the produced figure with no request');

  // Due again: a new card, a failed load retried sooner, the day changing, a forced redraw.
  calls.length = 0;
  cards = [summary, mk(['.fc-today', '.fc-today-value', '.fc-today-sub'])];
  await forecast.updateForecast(push(5));
  assert.ok(calls.some(u => u.startsWith('/api/solar-forecast')), 'a card the last load did not draw triggers a load');

  calls.length = 0;
  await forecast.updateForecast(push(5.2));
  assert.equal(calls.length, 0, 'and then it is quiet again');

  await forecast.updateForecast(undefined, { force: true });
  assert.ok(calls.some(u => u.startsWith('/api/solar-forecast')), 'a theme change (no state) redraws from the server');

  calls.length = 0;
  await forecast.updateForecast({ solarToday: { kwh: 1, date: '1999-01-01' } });
  assert.equal(calls.length, 0, 'a figure for another day is ignored, not shown');
  assert.match(summary._text['.fc-today-sub'] || '', /5\.2 produced/);
  console.log('ok - a new card or a theme change loads; a figure for another day is ignored');

  // The timer: five minutes, or one when the last load failed.
  const realNow = Date.now;
  calls.length = 0;
  Date.now = () => realNow() + 4 * 60 * 1000;
  await forecast.updateForecast(push(5.3));
  assert.equal(calls.length, 0, 'four minutes after a load: no request');
  Date.now = () => realNow() + 5 * 60 * 1000 + 1000;
  await forecast.updateForecast(push(5.4));
  assert.ok(calls.some(u => u.startsWith('/api/solar-forecast')), 'five minutes after a load: the forecast is fetched again');
  Date.now = realNow;

  let fail = true;
  const okFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); if (fail) throw new Error('offline'); return okFetch(url); };
  await forecast.updateForecast(undefined, { force: true });
  calls.length = 0;
  Date.now = () => realNow() + 30 * 1000;
  await forecast.updateForecast(push(5.5));
  assert.equal(calls.length, 0, 'thirty seconds after a failed load: not yet');
  Date.now = () => realNow() + 61 * 1000;
  fail = false;
  await forecast.updateForecast(push(5.6));
  assert.ok(calls.some(u => u.startsWith('/api/solar-forecast')), 'a minute after a failed load: it tries again');
  Date.now = realNow;
  console.log('ok - the forecast is fetched every five minutes, and a failed load is retried after one');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
