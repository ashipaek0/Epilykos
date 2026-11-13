'use strict';
const checks = require('./_checks');
// The prepaid meter (modules/prepaidMeter.js, routes/prepaid.js, the Prepaid meter card and the Grid card strip): the balance
// maths (counting, recharge, manual correction, learning, undo), storage and the tick, who may see and change what, the
// metrics and events, the words on the card, and that everything is wired in. (The drawing is checked in a browser.)
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { pathToFileURL } = require('url');
const REPO = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-prepaid-')));
const database = require(path.join(REPO, 'modules/database'));
database.initializeDatabase();
const P = require(path.join(REPO, 'modules/prepaidMeter'));
const load = f => import(pathToFileURL(path.join(REPO, 'public/js/components', f)).href);

(async () => {
  // ── Settings: off by default, thresholds optional ──
  assert.deepStrictEqual(P.cleanSettings({}), { enabled: false, warnKwh: null, warnDays: null, privateBalance: false });
  assert.deepStrictEqual(P.cleanSettings({ enabled: true, warnKwh: '10', warnDays: 0, privateBalance: true }), { enabled: true, warnKwh: 10, warnDays: null, privateBalance: true });
  assert.strictEqual(P.cleanSettings({ enabled: 'yes' }).enabled, false, 'only true switches it on');

  // ── Counting ──
  const last = { counter: 5, day: 'd1' };
  assert.strictEqual(P.counterDelta(last, 7.5, 'd1'), 2.5, 'the rise of the counter');
  assert.strictEqual(P.counterDelta(last, 2, 'd1'), 2, 'a counter that went back was reset: what it shows is new');
  assert.strictEqual(P.counterDelta(last, 3, 'd2'), 3, 'a new day: the counter started again');
  assert.strictEqual(P.counterDelta({ counter: null, day: '' }, 9, 'd1'), 0, 'the first reading has nothing before it');
  assert.strictEqual(P.counterDelta(last, 'x', 'd1'), 0);

  // ── Start, recharge, correct, undo ──
  let s = P.emptyState();
  assert.match(P.recharge(s, 60, 4080, 1).error, /meter shows first/, 'a recharge needs a balance to add to');
  assert.match(P.correct(s, -1, false, 1).error, /0 or more/); assert.match(P.correct(s, 'x', false, 1).error, /0 or more/);
  let r = P.correct(s, 40, true, 1000);
  assert.strictEqual(r.entry.type, 'start'); assert.strictEqual(s.balance, 40); assert.strictEqual(s.started, true); assert.strictEqual(s.fullAt, 40);
  P.applyUsage(s, 10, 'd1');
  assert.strictEqual(s.balance, 30); assert.strictEqual(s.usedToday, 10); assert.strictEqual(P.applyUsage(s, 0, 'd1'), 0, 'nothing used, nothing taken off');
  assert.match(P.recharge(s, 0, null, 1).error, /more than 0/); assert.match(P.recharge(s, 'x', null, 1).error, /more than 0/);
  const rc = P.recharge(s, 60, 4080, 2000);
  assert.strictEqual(s.balance, 90); assert.strictEqual(rc.entry.price, 68, 'the price per unit is worked out'); assert.strictEqual(rc.entry.amount, 4080); assert.strictEqual(s.fullAt, 90); assert.strictEqual(s.usedSinceRecharge, 0);
  assert.strictEqual(P.recharge(s, 10, null, 3).entry.price, null, 'no amount, no price'); P.undo(s, P.recharge(s, 5, 0, 4).entry);
  s = P.emptyState(); P.correct(s, 40, false, 1); P.applyUsage(s, 10, 'd1');
  const rc2 = P.recharge(s, 60, 4080, 2); P.applyUsage(s, 20, 'd1');
  assert.strictEqual(s.balance, 70); assert.deepStrictEqual(s.cal, { start: 40, recharged: 60, measured: 30 });
  // A manual correction at any time sets the balance to what the meter shows, and learns from the difference
  const chk = P.correct(s, 68, true, 3000);
  assert.strictEqual(s.balance, 68); assert.strictEqual(chk.entry.errorKwh, 2, 'the estimate was 2 kWh high'); assert.strictEqual(chk.entry.errorPct, 6.3, 'of the 32 kWh really used');
  assert.strictEqual(chk.entry.learned, true); assert.strictEqual(s.factor, 1.0333, 'half way to the 1.0667 that explains the difference');
  assert.deepStrictEqual(s.cal, { start: 68, recharged: 0, measured: 0 }, 'a new stretch to learn from');
  P.applyUsage(s, 10, 'd1'); assert.ok(Math.abs(s.balance - (68 - 10.333)) < 1e-9, 'later use is counted with the learned factor');
  // Without learning, or with too little to learn from, the factor stays
  s = P.emptyState(); P.correct(s, 50, false, 1); P.applyUsage(s, 1, 'd1'); P.correct(s, 40, true, 2);
  assert.strictEqual(s.factor, 1, 'under 2 kWh measured: nothing to learn from');
  s = P.emptyState(); P.correct(s, 50, false, 1); P.applyUsage(s, 10, 'd1'); P.correct(s, 30, false, 2); assert.strictEqual(s.factor, 1, 'not asked to learn');
  s = P.emptyState(); P.correct(s, 100, false, 1); P.applyUsage(s, 10, 'd1'); P.correct(s, 0, true, 2); assert.ok(s.factor <= 1.5 && s.factor >= 0.5, 'the factor stays within bounds');
  s = P.emptyState(); P.correct(s, 5, false, 1); P.applyUsage(s, 50, 'd1'); assert.strictEqual(s.balance, 0, 'never below 0');
  // Undo
  s = P.emptyState(); const e0 = P.correct(s, 40, false, 1).entry; P.applyUsage(s, 5, 'd1');
  const e1 = P.recharge(s, 60, 4080, 2).entry; P.applyUsage(s, 3, 'd1');
  assert.strictEqual(s.balance, 92); P.undo(s, e1); assert.strictEqual(s.balance, 32, 'the units come off; the use since stays counted'); assert.strictEqual(s.cal.recharged, 0); assert.strictEqual(s.usedSinceRecharge, 8);
  const e2 = P.correct(s, 30, false, 3).entry; assert.strictEqual(s.balance, 30); P.applyUsage(s, 2, 'd1'); P.undo(s, e2);
  assert.strictEqual(s.balance, 30 - 2 + (32 - 30) + 0, 'undoing a correction brings the estimate back, with the use since'); assert.strictEqual(s.balance, 30);
  P.undo(s, e0); assert.strictEqual(s.started, false, 'undoing the starting balance starts over'); assert.match(P.undo(s, null).error, /nothing to undo/i);

  // ── Level, days left ──
  const st = (balance, started = true) => ({ ...P.emptyState(), started, balance, fullAt: 60 });
  const set = P.cleanSettings({ enabled: true, warnKwh: 10, warnDays: 2 });
  assert.strictEqual(P.levelOf(st(0, false), set, null), 'unknown'); assert.strictEqual(P.levelOf(st(0), set, null), 'out'); assert.strictEqual(P.levelOf(st(9), set, null), 'low'); assert.strictEqual(P.levelOf(st(30), set, 1.5), 'low', 'days left can warn');
  assert.strictEqual(P.levelOf(st(30), set, 4), 'ok'); assert.strictEqual(P.levelOf(st(9), P.cleanSettings({ enabled: true }), 1), 'ok', 'no thresholds, no warning');
  const sum = P.summarize({ ...st(43.2), usedDay: '', factor: 1 }, set, [{ type: 'recharge', ts: 5, units: 60, amount: 4080, price: 68 }], 7.2, 1000000);
  assert.deepStrictEqual([sum.balance, sum.daysLeft, sum.avgDaily, sum.fill, sum.lastRecharge.price, sum.level], [43.2, 6, 7.2, 0.72, 68, 'ok']);
  assert.strictEqual(P.summarize(st(0), set, [], 7.2, 1).emptyOn, null); assert.strictEqual(P.summarize(st(10), set, [], null, 1).daysLeft, null, 'no history, no days left');

  // ── Storage and the tick ──
  const metricsOf = name => { database.flushMetrics(); const r = database.getDb().prepare('SELECT value FROM latest_metrics WHERE metric = ?').get(name); return r ? r.value : undefined; };
  const put = (name, v, t) => { database.queueMetricValue(name, v, t, 'kWh'); database.flushMetrics(); };
  const T0 = Math.floor(new Date(2026, 5, 10, 12, 0, 0).getTime() / 1000);
  assert.deepStrictEqual(P.tick(T0), { enabled: false }, 'off: nothing happens');
  assert.strictEqual(P.view({ authed: true }).enabled, false); assert.strictEqual(metricsOf('prepaid_balance'), undefined, 'and nothing is published');
  assert.strictEqual(P.saveSettings({ enabled: true, warnKwh: 10, warnDays: 2 }).source, 'none', 'no grid energy reading yet');
  assert.match(P.view({ authed: true }).problem, /daily grid import/);
  assert.match(P.addRecharge(60, null).error || '', /meter shows first/, 'needs a starting balance');
  put('daily_grid_import', 3, T0); P.tick(T0);
  assert.strictEqual(P.settingsView().source, 'counter'); assert.strictEqual(P.settingsView().metric, 'daily_grid_import');
  let v = P.addCorrection(40, true, T0).view;
  assert.strictEqual(v.balance, 40); assert.strictEqual(v.started, true); assert.strictEqual(v.ledger[0].type, 'start'); assert.ok(!('before' in v.ledger[0]), 'the undo data is not sent');
  put('daily_grid_import', 5, T0 + 30); P.tick(T0 + 30);
  assert.strictEqual(P.view({ authed: true }).balance, 38, 'the 2 kWh the counter rose by are taken off');
  assert.strictEqual(metricsOf('prepaid_balance'), 38, 'and published'); assert.strictEqual(metricsOf('prepaid_used_since_recharge'), 2);
  P.addRecharge(60, 4080, undefined, T0 + 40);
  assert.strictEqual(P.view({ authed: true }).balance, 98); assert.strictEqual(P.view({ authed: true }).lastRecharge.price, 68);
  put('daily_grid_import', 1, T0 + 86400); P.tick(T0 + 86400);   // the next day: the counter started again
  assert.strictEqual(P.view({ authed: true }).balance, 97, 'a new day counts from the counter again');
  // A restart in between loses nothing: the next reading still counts the rise since the saved one
  put('daily_grid_import', 4, T0 + 86460); P.resetPrepaidMeter(); P.tick(T0 + 86460);
  assert.strictEqual(P.view({ authed: true }).balance, 94);
  // Who sees what
  assert.strictEqual(P.view({ authed: false }).balance, 94); assert.ok(!('ledger' in P.view({ authed: false })), 'the entries are for a signed-in user');
  assert.strictEqual(P.view({ authed: false }).canEdit, false); assert.strictEqual(P.view({ authed: true }).canEdit, true);
  P.saveSettings({ privateBalance: true });
  assert.deepStrictEqual(P.view({ authed: false }), { enabled: true, hidden: true }, 'private: a viewer gets nothing');
  assert.strictEqual(P.view({ authed: true }).balance, 94, 'and a signed-in user everything');
  // Undo through the module
  assert.strictEqual(P.undoLast().view.balance, 94 - 60, 'the recharge is undone, the later use stays');
  P.addRecharge(60, null, undefined, T0 + 90000);

  // ── Events: low and out, once each ──
  const events = []; const { onEvent } = require(path.join(REPO, 'modules/notifications/events')); const off = onEvent(e => events.push(e.type));
  P.saveSettings({ privateBalance: false, warnKwh: 100 });   // 94 kWh is now under the warning level
  P.tick(T0 + 90060); P.tick(T0 + 90090);
  assert.deepStrictEqual(events, ['prepaid.low'], 'one low event, not one per poll');
  P.addCorrection(0, false, T0 + 90100); P.tick(T0 + 90120);
  assert.deepStrictEqual(events, ['prepaid.low', 'prepaid.out'], 'then out when it reaches 0'); off();
  const catalog = require(path.join(REPO, 'modules/notifications/events')).EVENT_TYPES;
  assert.ok(catalog['prepaid.low'] && catalog['prepaid.out'] && catalog['prepaid.out'].severity === 'critical', 'in the event catalog, for notification rules');

  // ── A private balance is not published ──
  database.flushMetrics(); database.getDb().prepare("DELETE FROM latest_metrics WHERE metric LIKE 'prepaid_%'").run();
  P.saveSettings({ privateBalance: true, warnKwh: 10 }); P.addCorrection(50, false, T0 + 90200); put('daily_grid_import', 6, T0 + 90230); P.tick(T0 + 90230);
  assert.strictEqual(metricsOf('prepaid_balance'), undefined, 'private: the balance is kept out of the metrics');
  P.saveSettings({ privateBalance: false });

  // ── Power fallback: no counter, the grid import power is integrated ──
  database.getDb().prepare("DELETE FROM latest_metrics WHERE metric = 'daily_grid_import'").run();
  P.saveSettings({ warnKwh: null }); P.addCorrection(20, false, T0 + 100000);
  put('grid_import', 3600, T0 + 100000); P.tick(T0 + 100000);
  assert.strictEqual(P.settingsView().source, 'power');
  put('grid_import', 3600, T0 + 101800); P.tick(T0 + 101800);   // 3.6 kW for the 10 minutes a poll gap is capped at: 0.6 kWh
  assert.ok(Math.abs(P.view({ authed: true }).balance - 19.4) < 0.02, 'power times the (capped) time since the last poll');

  // ── The API: who may do what ──
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.session = { authenticated: req.headers['x-test-auth'] === '1' }; next(); });
  app.use('/api/prepaid', require(path.join(REPO, 'routes/prepaid')));
  const server = await new Promise(res => { const sv = app.listen(0, '127.0.0.1', () => res(sv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/prepaid`;
  const call = async (p, { auth = false, body, method } = {}) => {
    const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-auth': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  assert.strictEqual((await call('/')).status, 200); assert.strictEqual((await call('/')).body.canEdit, false);
  for (const [p, body] of [['/recharge', { units: 5 }], ['/correct', { units: 5 }], ['/undo', {}], ['/settings', { enabled: false }]]) assert.strictEqual((await call(p, { body })).status, 401, p + ' needs a signed-in user');
  assert.strictEqual((await call('/settings')).status, 401);
  let res = await call('/recharge', { auth: true, body: { units: 'x' } }); assert.strictEqual(res.status, 400); assert.match(res.body.error, /more than 0/);
  res = await call('/recharge', { auth: true, body: { units: 30, amount: 2040 } }); assert.strictEqual(res.status, 200); assert.strictEqual(res.body.view.lastRecharge.price, 68);
  res = await call('/correct', { auth: true, body: { units: 25.5, learn: true } }); assert.strictEqual(res.status, 200); assert.strictEqual(res.body.view.balance, 25.5, 'a manual correction, any time');
  res = await call('/undo', { auth: true, body: {} }); assert.strictEqual(res.status, 200);
  assert.strictEqual((await call('/settings', { auth: true, body: { enabled: false } })).body.enabled, false);
  assert.strictEqual((await call('/')).body.enabled, false); assert.match((await call('/recharge', { auth: true, body: { units: 5 } })).body.error, /switched off/, 'off: no changes either');
  server.close();

  // ── The card ──
  const C = await load('prepaidMeter.js');
  let o = C.prepaidOptions({});
  assert.deepStrictEqual([o.title, o.showFacts, o.showHistory, o.segments, o.decimals], ['Prepaid meter', true, false, 12, null]);
  assert.strictEqual(C.prepaidOptions({ title: '' }).title, '', 'an empty title hides it'); assert.strictEqual(C.prepaidOptions({ segments: 99 }).segments, 40); assert.strictEqual(C.prepaidOptions({ segments: 0 }).segments, 0);
  const w = C.prepaidWords({ left: ' kWh maradt ', recharge: '', undo: 'x'.repeat(300) });
  assert.strictEqual(w.left, 'kWh maradt', 'a word of your own'); assert.strictEqual(w.recharge, 'Record recharge', 'empty: the English default'); assert.strictEqual(w.undo.length, 120);
  assert.deepStrictEqual(C.WORD_KEYS.length, 13);
  assert.strictEqual(C.daysLine({ daysLeft: 5.9, avgDaily: 7.2, emptyOn: new Date(2026, 5, 20).toISOString() }, '≈ {days} days at {avg} kWh a day · empty about {date}').startsWith('≈ 5.9 days at 7.2 kWh a day · empty about'), true);
  assert.strictEqual(C.daysLine({ daysLeft: 5.9, avgDaily: 7.2, emptyOn: null }, '≈ {days} days at {avg} kWh a day · empty about {date}'), '≈ 5.9 days at 7.2 kWh a day', 'no date: that part of the words is left out');
  assert.strictEqual(C.daysLine({ daysLeft: 12.4, avgDaily: 3, emptyOn: null }, '{days}d'), '12d'); assert.strictEqual(C.daysLine({ daysLeft: null }, '{days}'), '');
  assert.ok(!/Hungarian|Termel|Fogyaszt/.test(read('public/js/components/prepaidMeter.js')), 'no language of its own');
  assert.ok(!/(Recharged|Meter check|Correction)['"`]/.test(read('public/js/components/prepaidMeter.js')), 'the history shows symbols and numbers, not words');
  // The buttons record what the owner did by hand; they do not claim to talk to the meter
  const dlg = read('public/js/components/prepaidDialogs.js');
  assert.match(dlg, /does not buy or send one/); assert.match(dlg, /Nothing is sent to the meter/); assert.match(read('public/js/prepaid-settings.js'), /only record what you have done by hand/);

  // ── Wiring ──
  assert.match(read('public/js/components/index.js'), /'prepaid-meter': buildPrepaidMeter/);
  // The Grid card text: top right, level with the date, plain text with no bar, red from the warning level
  const pmSrc = read('public/js/components/prepaidMeter.js');
  assert.ok(!/pm-strip-bar|pm-strip-row/.test(pmSrc) && !/pm-strip-bar/.test(read('public/cards.css')), 'no bar on the Grid card');
  assert.match(read('public/js/components/gridCard.js'), /card\.querySelector\('\.ep-grid-head'\)\.appendChild\(buildPrepaidStrip/, 'placed in the head, with the date');
  const stripCss = read('public/cards.css');
  assert.match(stripCss, /\.pm-strip \{ margin-left: auto; text-align: right;/); assert.match(stripCss, /\.pm-strip\[data-level="low"\] :is\(\.pm-strip-main, \.pm-strip-sub\), \.pm-strip\[data-level="out"\] :is\(\.pm-strip-main, \.pm-strip-sub\) \{ color: #ef4444; \}/, 'red at the low level and when out');
  assert.ok(!/\.pm-strip \{[^}]*(background|border-radius)/.test(stripCss), 'no box around it');
  assert.match(read('public/js/cards-update.js'), /prepaid-meter'\) \|\| document\.querySelector\('\.pm-strip'\)\) updatePrepaidMeter\(state\)/, 'refreshed only where a card or a strip is');
  assert.match(read('public/js/editor-catalog.js'), /'prepaid-meter':\s+\{ group: 'values', name: 'Prepaid meter'/);
  const ed = read('public/js/editor.js');
  for (const id of ['modal-pm-title', 'modal-pm-facts', 'modal-pm-history', 'modal-pm-segments', 'modal-pm-decimals', 'modal-pm-w-', 'modal-grid-prepaid', 'modal-grid-pp-left', 'modal-grid-pp-days', 'modal-grid-pp-out']) assert.ok(ed.includes(id), id);
  assert.ok(ed.includes("case 'prepaid-meter': {") && ed.includes('function buildPrepaidMeterForm'), 'form and save');
  const fn = ed.indexOf('function readSettingsForm('); const save = ed.slice(ed.indexOf("case 'prepaid-meter': {", fn), ed.indexOf("case 'meter-card': {", fn));
  assert.ok(!/\btextSetting\b|\bnumberSetting\b|\bescHtml\b/.test(save), 'the save case uses only the document');
  const grid = read('public/js/components/gridCard.js');
  assert.match(grid, /kindName === 'grid' && config\.showPrepaid === true/, 'the strip is on the grid card only, and only when asked for');
  assert.match(read('server.js'), /app\.use\('\/api\/prepaid', require\('\.\/routes\/prepaid'\)\)/);
  assert.match(read('services/PollingManager.js'), /prepaidMeter'\)\.tick\(\)/, 'ticks with each poll cycle');
  const html = read('public/settings.html'); assert.match(html, /id="prepaid-card" data-own-save/); assert.match(html, /js\/prepaid-settings\.js/);
  // Its own page in Settings: a nav entry and a section of its own, and nothing added to Prices and savings
  assert.match(html, /<a href="#prepaid" class="st-nav-link" data-section="prepaid">/); assert.match(html, /<section class="st-section" id="section-prepaid" data-section="prepaid"/);
  const savings = html.slice(html.indexOf('id="section-savings"'), html.indexOf('PREPAID METER'));
  assert.ok(!/prepaid|pm-root/i.test(savings), 'the Prices and savings page is unchanged');
  assert.match(read('public/js/settings-shell.js'), /prepaid: 'Prepaid meter'/); assert.match(read('public/js/prepaid-settings.js'), /getElementById\('section-prepaid'\)/);
  assert.ok(!/SAVABLE = \[[^\]]*prepaid/.test(read('public/js/settings-shell.js')), 'the card saves itself, outside the page save bar');
  // One way to save: the settings are a draft until Save is pressed. The switch and the fields only change the form.
  const ps = read('public/js/prepaid-settings.js');
  assert.match(ps, /id="pm-save" disabled>Save/, 'Save starts off, and stays off until something changes');
  assert.match(ps, /\$\('pm-enabled'\)\.addEventListener\('change', function \(\) \{ \$\('pm-fields'\)\.hidden = !\$\('pm-enabled'\)\.checked; drawBalance\(\); markDirty\(\); \}\)/, 'the switch only shows or hides the fields');
  assert.ok(!/addEventListener\('change', save\)/.test(ps), 'nothing saves before Save is pressed');
  assert.strictEqual((ps.match(/api\('\/api\/prepaid\/settings', /g) || []).length, 1, 'the settings are sent from one place: the Save button');
  assert.ok(!html.includes('id="pm-status"') && /stShell\.toast/.test(ps), 'feedback is the page\u2019s toast, not a box inside the card');
  assert.match(read('public/js/prepaid-settings.js'), /Everyone who can see the dashboard[\s\S]*Only me, when signed in/, 'who can see the balance is a setting');
  const sc = read('private/js/showcase-layout.js'), so = read('private/js/showcase.js'), sd = read('private/js/showcase-data.js');
  assert.ok(sc.includes("type: 'prepaid-meter'") && so.includes("'prepaid-meter': [") && sd.includes('prepaidDemo'), 'in the showcase');
  assert.match(sc, /type: 'grid-card', config: \{ showPrepaid: true \}/);
  const css = read('public/cards.css');
  assert.match(css, /\.prepaid-card\s*\{[^}]*container-type:\s*size/); assert.match(css, /@media \(max-width: 768px\)[^}]*\.prepaid-card \{ min-height/); assert.match(css, /\.pm-strip\[data-level="low"\]/);
  assert.ok(fs.existsSync(path.join(REPO, 'public/prepaid-dialog.css')) && dlg.includes('/prepaid-dialog.css'), 'the dialogs bring their own stylesheet');

  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
