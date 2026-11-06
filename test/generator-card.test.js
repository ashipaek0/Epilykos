'use strict';
const checks = require('./_checks');
/**
 * Generator status card, with made-up values:
 * - "running" comes from the generator status metric when one is set, and
 *   otherwise from the generator power role (above 20 W);
 * - changes are recorded with a minimum dwell and raise generator.on / .off,
 *   but the first reading raises nothing;
 * - run hours per period, per day and the 24-hour timeline read the
 *   generator_status table, and leave the grid's table alone;
 * - the cost is the daily generator energy times the generator price, and
 *   says it needs a price rather than showing 0;
 * - the card is registered everywhere a card type must be.
 */
process.env.TZ = 'Africa/Lagos';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-generatorcard-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');

const database = require('../modules/database');
database.initializeDatabase();
const db = database.getDb();
const generator = require('../modules/generator');
const { onEvent } = require('../modules/notifications/events');
const { computeGeneratorCost } = require('../routes/metrics');

const H = 3600;
const now = new Date();
const nowS = Math.floor(now.getTime() / 1000);
const midnight = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
const dayAgo = n => Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime() / 1000);
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.02, `${what}: ${a} vs ${b}`);
const latest = (metric, value, text) => db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, value_text, timestamp) VALUES (?, ?, ?, ?)').run(metric, value, text ?? null, nowS);
const rows = () => db.prepare('SELECT state FROM generator_status ORDER BY timestamp').all().map(r => r.state);

(async () => {
  const events = [];
  onEvent(e => { if (e.type.startsWith('generator.')) events.push(e.type); });

  // Nothing set up.
  assert.deepEqual(await generator.getCurrentGeneratorStatus(), { configured: false, available: false });
  assert.equal(generator.generatorSource(), null);
  assert.deepEqual(await generator.getGeneratorTimeline(), { configured: false, available: false, segments: [] });
  await generator.pollGeneratorStatus();
  assert.deepEqual(rows(), [], 'nothing recorded without a source');

  // From the power role: running above 20 W.
  database.setConfig('role_metrics', JSON.stringify({ generator: 'gen_power' }));
  assert.deepEqual(generator.generatorSource(), { kind: 'power', metric: 'gen_power' });
  latest('gen_power', 5);
  await generator.pollGeneratorStatus();
  assert.deepEqual(rows(), [0], '5 W is stopped: the input idles at a few watts');
  assert.deepEqual(events, [], 'the first reading is not a start or stop');
  let st = await generator.getCurrentGeneratorStatus();
  assert.equal(st.configured, true); assert.equal(st.available, true); assert.equal(st.current, false); assert.equal(st.source, 'power');

  latest('gen_power', 3400);
  await generator.pollGeneratorStatus();
  assert.deepEqual(rows(), [0], 'a change inside the 60 s dwell is not recorded');
  db.prepare('UPDATE generator_status SET timestamp = timestamp - 3600').run();
  await generator.pollGeneratorStatus();
  assert.deepEqual(rows(), [0, 1], 'running once the dwell has passed');
  assert.deepEqual(events, ['generator.on'], 'a start raises generator.on');
  st = await generator.getCurrentGeneratorStatus();
  assert.equal(st.current, true); assert.ok(st.lastOn > 0 && st.lastChange.state === 1);
  await generator.pollGeneratorStatus();
  assert.deepEqual(rows(), [0, 1], 'the same state twice records nothing');

  // A status metric wins over the power role.
  database.setConfig('generator_status_entity', 'gen_switch');
  assert.deepEqual(generator.generatorSource(), { kind: 'status', metric: 'gen_switch' });
  latest('gen_switch', null, 'off');
  st = await generator.getCurrentGeneratorStatus();
  assert.equal(st.current, false); assert.equal(st.source, 'status');
  db.prepare('UPDATE generator_status SET timestamp = timestamp - 3600').run();
  await generator.pollGeneratorStatus();
  assert.deepEqual(rows(), [0, 1, 0]);
  assert.deepEqual(events, ['generator.on', 'generator.off'], 'a stop raises generator.off');
  latest('gen_switch', null, 'unavailable');
  assert.equal((await generator.getCurrentGeneratorStatus()).available, false, 'unavailable is no data, not stopped');
  console.log('ok - generator state: status metric or power above 20 W, dwell, start and stop events');

  // Hours, per day and timeline read the generator table only.
  db.prepare('DELETE FROM generator_status').run();
  const ins = db.prepare('INSERT INTO generator_status (timestamp, state) VALUES (?, ?)');
  ins.run(dayAgo(2) + 6 * H, 1); ins.run(dayAgo(2) + 9 * H, 0);     // 3 h two days ago
  ins.run(dayAgo(1) + 20 * H, 1); ins.run(dayAgo(1) + 23 * H, 0);   // 3 h yesterday evening
  const days = generator.getGeneratorDailyHours(7);
  assert.equal(days.length, 7);
  near(days[4].hours, 3, '2 days ago');
  near(days[5].hours, 3, 'yesterday: 20:00 to 23:00');
  near(days[6].hours, 0, 'today: not run');
  assert.ok(days[6].today);
  near(await generator.getGeneratorHours('all'), 6, 'all time');
  const tl = await generator.getGeneratorTimeline();
  assert.equal(tl.configured, true);
  assert.ok(tl.segments.length >= 1 && tl.segments.every(s => s.state === 0 || s.state === 1));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grid_status').get().n, 0, 'the grid table is untouched');
  assert.equal(await require('../modules/grid').getGridHours('all'), 0, 'and reads nothing from the generator');
  console.log('ok - generator hours per period, per day and timeline');

  // Cost.
  assert.deepEqual(computeGeneratorCost(db), { available: false }, 'no daily generator metric');
  database.setConfig('role_metrics', JSON.stringify({ generator: 'gen_power', daily_generator: 'gen_today' }));
  assert.deepEqual(computeGeneratorCost(db), { available: false, needsPrice: true }, 'no price is not free power');
  database.setConfig('generator_price', '250');
  database.setConfig('savings_currency', '₦');
  db.prepare('INSERT OR REPLACE INTO history (timestamp, daily_generator) VALUES (?, ?)').run(dayAgo(1) + 23 * H, 8);
  require('../modules/timeseriesReader').clearDailySnapshotCache(db);
  const c = computeGeneratorCost(db);
  assert.equal(c.available, true); assert.equal(c.price, 250); assert.equal(c.currency, '₦');
  assert.equal(c.kwh.all, 8); assert.equal(c.cost.all, 2000);
  console.log('ok - generator cost: daily generator energy × generator price; needs a price');

  // The status shape the card reads is in the dashboard state.
  const { buildDashboardState } = require('../routes/metrics');
  const state = await buildDashboardState();
  for (const k of ['generatorStatus', 'generatorHours', 'generatorTimeline', 'generatorDaily', 'generatorCost']) assert.ok(k in state, `state has ${k}`);
  assert.equal(state.generatorStatus.configured, true);
  assert.equal(state.generatorDaily.days.length, 30);
  assert.ok('gridStatus' in state && 'gridDaily' in state, 'the grid keys are still there');
  console.log('ok - dashboard state carries the generator keys');

  // Registered everywhere a card type is.
  const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
  assert.match(read('public/js/components/index.js'), /'generator-card': buildGeneratorCard/);
  assert.match(read('public/js/editor-catalog.js'), /'generator-card':\s+\{ group: 'values'.*w: 6, h: 6 \}/);
  assert.match(read('public/js/cards-update.js'), /blockTypes\.has\('generator-card'\)/);
  assert.match(read('public/js/editor.js'), /case 'generator-card':\s+html \+= buildGridCardForm\(block, true\)/);
  assert.match(read('public/js/dashboard.js'), /'generatorStatus', 'generatorHours', 'generatorTimeline', 'generatorDaily', 'generatorCost'/);
  assert.match(read('public/settings.html'), /name="generator_status_entity"/);
  assert.match(read('server.js'), /'grid_status_entity', 'generator_status_entity'/);
  assert.match(read('services/PollingManager.js'), /id: 'generator'/);
  assert.match(read('public/cards.css'), /\.grid-card\.generator-card \.ep-grid-state\[data-state="on"\]/);
  console.log('ok - generator card is registered, editable and styled');

  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
