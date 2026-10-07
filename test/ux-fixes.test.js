'use strict';
const checks = require('./_checks');
// Card and page fixes found by rendering every card fresh, at desktop and
// phone width: sizes, empty states, plain messages, rate limiting.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('url');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

(async () => {
  await check('rate limit: API calls count, pages and their files do not (no blank 429 page after a few reloads)', () => {
    const srv = read('server.js');
    assert.match(srv, /skip: req => \(req\.method === 'GET' \|\| req\.method === 'HEAD'\) && !req\.path\.startsWith\('\/api\/'\)/);
  });

  await check('forecast and weather problems read as what to do, not the server\'s error text', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-fp-'));
    fs.writeFileSync(path.join(tmp, 'fp.mjs'), read('public/js/forecastProblem.js'));
    const { forecastProblem: f } = await import(pathToFileURL(path.join(tmp, 'fp.mjs')).href);
    assert.strictEqual(f({ label: 'Auto', error: 'Location required for Open-Meteo' }), 'Set your location in Settings › Forecast and weather to see a forecast.');
    assert.strictEqual(f({ error: 'Location required', what: 'weather' }), 'Set your location in Settings › Forecast and weather to see the weather.');
    assert.match(f({ label: 'Solcast', error: 'Solcast unavailable', lastGood: '10:02' }), /Check the API key.*Last forecast at 10:02\.$/);
    assert.strictEqual(f({ label: 'Auto', error: 'All forecast sources unavailable' }), 'The forecast service can\'t be reached right now. It tries again on its own.');
    assert.match(f({ error: 'Source unavailable: rest:roof' }), /"roof" isn't set up/);
    for (const file of ['public/js/forecast.js', 'public/js/components/pvToday.js', 'public/js/components/weatherBlock.js']) {
      const src = read(file);
      assert.match(src, /forecastProblem\(/, `${file} uses it`);
      assert.doesNotMatch(src, /`Source \$\{label/, `${file} no longer shows "Source … unavailable"`);
    }
    assert.match(read('public/style.css'), /\.pvt-is-empty \.pvt-legend, \.pvt-is-empty \.pv-today-timeline \{ visibility: hidden; \}/, 'PV Today message no longer sits on its legend');
  });

  await check('a card without what it needs says what to choose, in the same words everywhere', () => {
    assert.match(read('public/js/components/emptyState.js'), /CHOOSE_METRIC = 'Choose a metric for this block in the layout editor\.'/);
    const uses = { gaugeCard: /if \(!metric\) return emptyBlock/, halfGaugeCard: /if \(!metric\) return emptyBlock/, halfGauge2Card: /if \(!metric\) return emptyBlock/, configurableGaugeCard: /if \(!c\.metric\) return emptyBlock/, barGauge: /if \(!rows\.some\(r => r && r\.metric\)\) return emptyBlock/, barGaugeRetro: /if \(!rows\.some\(r => r && r\.metric\)\) return emptyBlock/, multiValueCard: /return emptyBlock\('Choose the metrics/, metricTrendCard: /if\(c\.value\.source==='metric'&&!c\.value\.metric\)return emptyBlock/, dualMetricCard: /return emptyBlock\('Choose the two metrics/, switchBlock: /if \(!config\.entity\) return emptyBlock\('Choose the switch/ };
    for (const [f, re] of Object.entries(uses)) assert.match(read(`public/js/components/${f}.js`), re, f);
    for (const f of ['barSingleCard', 'barStackedCard', 'barThresholdCard', 'textMetricCard']) assert.match(read(`public/js/components/${f}.js`), /NO_METRIC_TEXT = 'Choose a metric for this block in the layout editor\.'/, f);
    assert.match(read('public/js/components/stateSelectBlock.js'), /Choose the entity and its states for this block in the layout editor\./);
  });

  await check('cards fit their default size: topology scales, flow card stays on one row, grid status and state select are tall enough', () => {
    const css = read('public/style.css');
    assert.match(css, /\.flow-card-2 \{ container-type: size;/);
    assert.match(css, /\.flow-card-2 \{ --topo-d: clamp\(64px, calc\(\(100cqh - 5\.5rem - var\(--topo-extra, 0\) \* 0\.95rem\) \/ 3\), 120px\); \}/);
    assert.match(css, /@media \(max-width: 768px\) \{ \.flow-card-2 \{ --topo-d: 84px; \} \}\s*$/m, 'phones: fixed size, and last so it wins');
    assert.match(read('public/js/components/systemTopology.js'), /container\.style\.setProperty\('--topo-extra'/);
    assert.match(css, /\.flow-card \{ container-type: inline-size; \}/);
    const cat = read('public/js/editor-catalog.js');
    assert.match(cat, /'grid-card':.*w: 6, h: 6 \}/); assert.match(cat, /'state-select':.*w: 4, h: 3 \}/);
  });

  await check('phones: tables keep their rows; grid timeline labels stay inside; on is green like the status', () => {
    const css = read('public/style.css');
    assert.match(css, /\.daily-table-wrapper \{ flex: none; max-height: 60vh; \}/);
    assert.match(read('public/js/grid.js'), /if \(pct < 6\) \{ tick\.style\.transform = 'none';/);
    assert.match(css, /\.tl-segment\.on \{ background: var\(--success\);/);
    assert.match(css, /\.ep-grid-state\[data-state="on"\] \{ color: var\(--success\); \}/);
  });

  await check('Settings › Metrics: roles first, readable values, a delete you can see and that explains itself', () => {
    const html = read('public/settings.html');
    const sec = html.slice(html.indexOf('id="section-metrics"'), html.indexOf('id="section-forecast"'));
    assert.ok(sec.indexOf('Metric roles') < sec.indexOf('Combined metrics') && sec.indexOf('Combined metrics') < sec.indexOf('All metrics'), 'roles, combined, then the full list');
    assert.match(sec, /<p class="status" id="metrics-status" role="status"><\/p>/); assert.match(sec, /<p class="status" id="cm-status" role="status"><\/p>/);
    const js = read('public/settings.js');
    assert.match(js, /function formatMetricReading\(value, unit\)/); assert.match(js, /function readingAge\(ts\)/);
    assert.match(js, /aria-label="Delete \$\{name\}">Delete<\/button>/, 'labelled Delete, not a bare ✕');
    assert.match(js, /showStatus\(status, body\.error \|\| `Couldn't delete/, 'feedback in the Metrics card (it went to the hidden Backup section)');
    assert.match(js, /if \(ms && ms\.value\) ms\.dispatchEvent\(new Event\('input'\)\)/, 'filter survives a reload of the list');
    assert.match(read('public/settings-shell.css'), /\.st #metrics-table \.delete-metric-btn \{ opacity: 1; \}/);
    assert.doesNotMatch(read('public/js/combined-metrics.js'), /alert\(/);
    const srv = read('server.js');
    assert.match(srv, /is a combined metric\. Delete it under Combined metrics/);
    assert.match(srv, /res\.json\(\{ success: true, roles_cleared: rolesCleared, used_by: usedBy \}\)/);
    assert.match(read('modules/metricsManager.js'), /SELECT metric, value, value_text, timestamp, unit FROM latest_metrics/, 'units the sources reported are listed');
  });

  await check('combined metric suggestions skip what already exists under another name', () => {
    const js = read('public/js/combined-metrics.js');
    assert.match(js, /var covered = function \(inputs\)/); assert.match(js, /pv_total_power: hasKind\(\['sum'\], \/\(pv\|solar\)\/i\)/);
    assert.match(js, /a\[href="#metrics\/combined"\]/, 'every link to the card opens it');
  });

  await check('wizard: array size optional and aware of several PV arrays; fresh installs keep the default; no 401 probe', () => {
    const wz = read('public/js/setup.js');
    assert.match(wz, /\(cap === '' \|\| \(!isNaN\(Number\(cap\)\) && Number\(cap\) >= 0\)\)/, 'empty size allowed');
    assert.match(wz, /var set = function \(v\) \{ return v != null && String\(v\)\.trim\(\) !== ''; \};/, 'empty saved values keep the defaults');
    assert.match(wz, /b\.arrays && b\.arrays\.length > 1\s*\? field\('Solar arrays'/, 'several arrays: shown, changed in Settings');
    assert.match(wz, /payload\.solar_arrays = JSON\.stringify\(\[Object\.assign\(\{\}, b\.arrays\[0\], \{ kwp: Number\(cap\) \}\)\]\)/, 'one saved array kept in step');
    assert.match(wz, /api\('\/api\/auth\/status'\)\.then\(function \(res\) \{\s*return !!\(res\.ok && res\.data && res\.data\.authenticated\);/);
    assert.doesNotMatch(wz, /Finish to open your dashboard/);
  });

  await check('Settings asks in its own dialog, never the browser\'s confirm/alert/prompt', () => {
    for (const f of ['public/settings.js', 'public/js/settings-shell.js', 'public/js/combined-metrics.js', 'public/js/pv-arrays.js']) {
      const code = read(f).split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      assert.doesNotMatch(code, /(^|[^.\w])(confirm|alert|prompt)\(/, `${f} uses a browser dialog`);
    }
    const js = read('public/settings.js');
    assert.match(js, /if \(typeof window\.stConfirm === 'function'\) return window\.stConfirm\(/);
    assert.match(js, /return Promise\.resolve\(false\);/, 'no dialog: refuse rather than act unasked');
    assert.strictEqual((js.match(/await showConfirm\(/g) || []).length, 18, 'every caller waits for the answer');
    assert.match(js, /if \(!\(await confirmImplicitToExplicitNoneFlips\(\)\)\)/);
    const shell = read('public/js/settings-shell.js');
    assert.match(shell, /window\.stConfirm = stConfirm;/);
    assert.match(shell, /alert: true, actions: \[\{ label: 'Cancel', value: null \}/, 'Cancel first and focused');
  });

  await check('metric chart asks for a metric; grid timeline details on touch and keyboard too', () => {
    const cm = read('public/js/components/chartMetric.js');
    assert.doesNotMatch(cm, /metric: 'consumption_kw'/, 'no invented default series');
    assert.match(cm, /if \(!datasets\.length\) return emptyBlock\('Choose the metrics for this chart in the layout editor\.', id\);/);
    const g = read('public/js/grid.js');
    assert.match(g, /el\.tabIndex = 0;/); assert.match(g, /el\.setAttribute\('aria-label', text\);/);
    assert.match(g, /el\.addEventListener\('focus', show\);/); assert.match(g, /e\.key === 'Enter' \|\| e\.key === ' '/);
    assert.match(g, /pointerenter', e => \{ if \(e\.pointerType === 'mouse'\) show\(\);/, 'hover for a mouse only');
    assert.match(g, /Date\.now\(\) - tooltip\._shownAt > 400/, 'a tap opens rather than flickering shut');
    assert.match(read('public/style.css'), /\.tl-tooltip \{ white-space: nowrap; max-width: calc\(100vw - 32px\); transform: translateX\(-50%\); \}/);
  });

  await check('public history capped at the 7 days cards use; Bluetooth timing and per-part start explained', () => {
    const srv = read('server.js');
    assert.match(srv, /const maxHours = signedIn \? 8760 : 168;/);
    assert.match(srv, /Without signing in, history covers up to 7 days \(168 hours\)\./);
    for (const f of ['public/js/components/metricTrendLogic.js', 'public/js/components/configurableGaugeLogic.js', 'public/js/components/barCardLogic.js']) {
      const hours = [...read(f).matchAll(/'(?:1h|6h|24h|3d|7d)'\s*:\s*(\d+)/g)].map(m => Number(m[1]));
      assert.ok(hours.length && Math.max(...hours) <= 168, `${f} asks for no more than the public cap`);
    }
    const st = read('public/settings.js');
    assert.match(st, /devices on one adapter are read one at a time, so allow about 10 seconds per device/);
    assert.match(st, /Devices on one adapter are read one at a time: with several batteries or inverters on Bluetooth/, 'kept when Bluetooth reports ready');
    const wz = read('public/js/setup.js');
    assert.match(wz, /need = Math\.max\(30, units \* 10\)/); assert.match(wz, /Set Read every to at least ' \+ need \+ ' seconds/);
    assert.match(read('public/js/combined-metrics.js'), /that starts when you save it, so earlier days show no parts/);
  });

  console.log(`ux-fixes: ${passed} checks passed`);
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
