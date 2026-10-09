'use strict';
const checks = require('./_checks');
/**
 * The Controls page's own layout (modules/dashboard-config.js,
 * GET/POST /api/controls/layout):
 * - switch and selector cards already on dashboards move there once, keep
 *   their settings and size, and leave the dashboards;
 * - cards that arrive with a later dashboard save (an import, an old tab)
 *   are moved too, never duplicated and never saved on a dashboard;
 * - only switch and selector cards can be saved on it;
 * - the route needs a signed-in session (the dashboard config is public).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-ctlayout-'));
process.chdir(tmp);
const database = require('../modules/database');
database.initializeDatabase();
const { getDashboardConfig, saveDashboardConfig, getControlsLayout, saveControlsLayout } = require('../modules/dashboard-config');

const sw = (id, extra = {}) => ({ id, type: 'switch-block', enabled: true, gridX: 0, gridY: 0, gridW: 3, gridH: 2, config: { label: 'Pump ' + id, entity: 'switch.made_up_' + id }, ...extra });
const sel = id => ({ id, type: 'state-select', enabled: true, gridX: 4, gridY: 0, gridW: 4, gridH: 3, config: { label: 'Mode ' + id } });
const text = id => ({ id, type: 'text-card', enabled: true, gridX: 0, gridY: 2, gridW: 6, gridH: 2, config: { content: 'Hi' } });

// An install from before the Controls page had its own layout.
database.setConfig('controls_layout', '');
database.setConfig('dashboard_layouts', JSON.stringify([
  { id: 'main', name: 'Main', layout: [text('t1'), sw('s1'), sel('q1')] },
  { id: 'two', name: 'Two', layout: [sw('s2', { gridW: 12 }), text('t2')] }
]));

const types = cfg => cfg.dashboards.map(d => d.layout.map(b => b.type));
const cfg = getDashboardConfig();
assert.deepStrictEqual(types(cfg), [['text-card'], ['text-card']], 'cards leave the dashboards');
let layout = getControlsLayout();
assert.deepStrictEqual(layout.map(b => b.id), ['s1', 'q1', 's2'], 'moved in dashboard order');
assert.strictEqual(layout[0].config.entity, 'switch.made_up_s1', 'settings kept');
assert.deepStrictEqual(layout.map(b => [b.gridX, b.gridY, b.gridW, b.gridH]), [[0, 0, 3, 2], [3, 0, 4, 3], [0, 3, 12, 2]], 'packed row by row, sizes kept');
assert.deepStrictEqual(JSON.parse(database.getConfig('dashboard_config')).dashboards.map(d => d.layout.length), [1, 1], 'legacy blob updated too');

// A second read doesn't move anything again.
assert.strictEqual(getControlsLayout().length, 3);

// A dashboard save that still carries cards: new ones move, known ones aren't duplicated.
saveDashboardConfig({ activeDashboard: 'main', dashboards: [{ id: 'main', name: 'Main', layout: [text('t1'), sw('s1'), sw('s9')] }] });
assert.deepStrictEqual(JSON.parse(database.getConfig('dashboard_layouts'))[0].layout.map(b => b.id), ['t1'], 'not saved on a dashboard');
layout = getControlsLayout();
assert.deepStrictEqual(layout.map(b => b.id), ['s1', 'q1', 's2', 's9'], 'new card added, known one not duplicated');
assert.strictEqual(layout[3].gridY, 5, 'added below the existing cards');

// Only switch and selector cards, each with an id.
assert.throws(() => saveControlsLayout([text('x')]), /Only switch and selector/);
assert.throws(() => saveControlsLayout({}), /list of blocks/);
assert.throws(() => saveControlsLayout([{ type: 'switch-block' }]), /needs an id/);
assert.throws(() => saveControlsLayout(Array.from({ length: 201 }, (_, i) => sw('m' + i))), /At most 200/);
saveControlsLayout([sel('q1')]);
assert.deepStrictEqual(getControlsLayout().map(b => b.id), ['q1']);

// Route: signed in only.
const express = require('express');
const session = require('express-session');
const app = express();
app.use(express.json());
app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
app.get('/test-login', (req, res) => { req.session.authenticated = true; res.send('ok'); });
const isAuthenticated = (req, res, next) => (req.session && req.session.authenticated ? next() : res.status(401).json({ error: 'Unauthorized' }));
app.use('/api/controls', isAuthenticated, require('../routes/controls'));

function request(server, method, p, cookie, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const server = app.listen(0, async () => {
  try {
    assert.strictEqual((await request(server, 'GET', '/api/controls/layout')).status, 401, 'signed out: refused');
    assert.strictEqual((await request(server, 'POST', '/api/controls/layout', null, { layout: [] })).status, 401);
    const login = await request(server, 'GET', '/test-login');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const got = await request(server, 'GET', '/api/controls/layout', cookie);
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(JSON.parse(got.body).layout.map(b => b.id), ['q1']);
    assert.strictEqual((await request(server, 'POST', '/api/controls/layout', cookie, { layout: [text('x')] })).status, 400);
    assert.strictEqual((await request(server, 'POST', '/api/controls/layout', cookie, { layout: [sw('s1'), sel('q2')] })).status, 200);
    assert.deepStrictEqual(getControlsLayout().map(b => b.id), ['s1', 'q2']);
    server.close();
    checks.done();
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});
