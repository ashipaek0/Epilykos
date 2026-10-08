'use strict';
const checks = require('./_checks');
/**
 * Page-load speed fixes:
 * - readDailySnapshots groups by local day without SQLite's per-row
 *   'localtime' (which stalled the server for seconds on a month of data) and
 *   gives the same days and values as that reference, in time zones with DST
 *   and with half- and quarter-hour offsets;
 * - the cached all-time read matches an uncached one, and sees today's new data;
 * - pages with module scripts are served with a modulepreload for every
 *   module they import;
 * - no page waits on a third-party stylesheet or the GridStack CDN.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

if (process.argv[2] === 'tz-child') {
  // Runs under a given TZ: compare the new grouping with SQLite 'localtime'.
  const Database = require('better-sqlite3');
  const { readDailySnapshots } = require('../modules/timeseriesReader');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE history (timestamp INTEGER PRIMARY KEY, daily_solar REAL, daily_consumption REAL);
    CREATE TABLE history_5m (bucket_start INTEGER PRIMARY KEY, daily_solar_last REAL, daily_consumption_last REAL);`);
  const ins = db.prepare('INSERT INTO history VALUES (?,?,?)');
  const ins5 = db.prepare('INSERT INTO history_5m VALUES (?,?,?)');
  // Made-up readings across 2026's DST changes (both hemispheres), every 7 minutes.
  let n = 0;
  for (const [a, b] of [[Date.UTC(2026, 2, 26), Date.UTC(2026, 3, 7)], [Date.UTC(2026, 9, 22), Date.UTC(2026, 10, 3)]]) {
    for (let t = a / 1000; t < b / 1000; t += 420) { ins.run(t, (t % 86400) / 3600, n++ % 50); }
  }
  for (let t = Date.UTC(2026, 0, 1) / 1000; t < Date.UTC(2026, 0, 6) / 1000; t += 300) ins5.run(t, (t % 86400) / 7200, 3);
  const ref = db.prepare(`SELECT day, MAX(daily_solar) AS daily_solar, MAX(daily_consumption) AS daily_consumption FROM (
    SELECT date(timestamp, 'unixepoch', 'localtime') AS day, daily_solar, daily_consumption FROM history
    UNION ALL SELECT date(bucket_start, 'unixepoch', 'localtime') AS day, daily_solar_last, daily_consumption_last FROM history_5m
  ) GROUP BY day ORDER BY day`).all();
  const got = readDailySnapshots(db, { fields: ['daily_solar', 'daily_consumption'] });
  process.stdout.write(JSON.stringify({ same: JSON.stringify(ref) === JSON.stringify(got), days: got.length }));
  process.exit(0);
}

for (const tz of ['UTC', 'Europe/London', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Adelaide', 'Africa/Lagos']) {
  const out = JSON.parse(execFileSync(process.execPath, [__filename, 'tz-child'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  assert.ok(out.same, `daily grouping matches SQLite localtime in ${tz}`);
  assert.ok(out.days > 20, `${tz}: ${out.days} days`);
}

// Cached all-time read = uncached, and today's new value shows at once.
{
  const Database = require('better-sqlite3');
  const { readDailySnapshots } = require('../modules/timeseriesReader');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE history (timestamp INTEGER PRIMARY KEY, daily_solar REAL);
    CREATE TABLE history_5m (bucket_start INTEGER PRIMARY KEY, daily_solar_last REAL);`);
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare('INSERT INTO history VALUES (?,?)');
  for (let t = now - 5 * 86400; t < now - 60; t += 600) ins.run(t, (t % 86400) / 3600);
  const plain = readDailySnapshots(db, { fields: ['daily_solar'] });
  assert.deepStrictEqual(readDailySnapshots(db, { fields: ['daily_solar'], cached: true }), plain, 'cached = uncached');
  ins.run(now, 999);
  const after = readDailySnapshots(db, { fields: ['daily_solar'], cached: true });
  assert.strictEqual(after[after.length - 1].daily_solar, 999, "today's new reading is seen");
  assert.deepStrictEqual(after.slice(0, -1), plain.slice(0, -1), 'finished days unchanged');
}

// Module preloads cover each page's whole import graph.
{
  const { pageWithPreloads, moduleGraph } = require('../modules/pagePreload');
  for (const [file, url, entry] of [['public/index.html', '/', '/js/main.js'], ['public/editor.html', '/editor', '/js/editor.js'],
    ['private/pages/controls.html', '/controls', '/private/js/controls.js'], ['private/pages/showcase.html', '/showcase', '/private/js/showcase.js']]) {
    const html = pageWithPreloads(path.join(ROOT, file), url);
    const graph = moduleGraph(entry);
    assert.ok(graph.length > 20, `${file}: ${graph.length} modules`);
    for (const u of graph) assert.ok(html.includes(`<link rel="modulepreload" href="${u}">`), `${file} preloads ${u}`);
    for (const u of graph) assert.ok(fs.existsSync(path.join(ROOT, u.startsWith('/private/') ? '' : 'public', u.split('?')[0])), `${u} exists`);
    assert.ok(html.indexOf('modulepreload') < html.indexOf('</head>'), 'in the head');
  }
}

// No render-blocking third-party files.
{
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.doesNotMatch(css, /@import\s+url\(['"]?https?:/, 'style.css imports nothing from other sites');
  assert.match(css, /url\('\/fonts\/manrope-latin-wght-normal\.woff2'\)/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/fonts/manrope-latin-wght-normal.woff2')) && fs.existsSync(path.join(ROOT, 'public/fonts/Manrope-OFL.txt')));
  const editor = fs.readFileSync(path.join(ROOT, 'public/editor.html'), 'utf8');
  assert.doesNotMatch(editor, /cdn\.jsdelivr\.net\/npm\/gridstack/);
  assert.ok(fs.existsSync(path.join(ROOT, 'node_modules/gridstack/dist/gridstack-all.js')), 'GridStack is installed with the app');
  for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html')).map(f => 'public/' + f).concat(['private/pages/controls.html', 'private/pages/showcase.html'])) {
    const head = fs.readFileSync(path.join(ROOT, f), 'utf8').split('</head>')[0];
    assert.doesNotMatch(head, /<link[^>]+rel="stylesheet"[^>]+href="https?:\/\//, `${f}: no third-party stylesheet in the head`);
    assert.doesNotMatch(head, /<script(?![^>]*\b(?:async|defer)\b)[^>]+src="https?:\/\//, `${f}: no blocking third-party script in the head`);
  }
}

checks.done();
