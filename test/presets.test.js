'use strict';
const checks = require('./_checks');
// Dashboard presets: every shipped preset is well formed, only uses cards the editor knows, carries nothing
// personal, imports cleanly, and the signed-in API serves exactly what is listed.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const express = require('express');
const { pathToFileURL } = require('url');
const { listPresets, getPreset, previewPath, metricsUsed, DIR } = require('../modules/presets');

(async () => {
  const { BLOCKS } = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/editor-catalog.js')).href);
  const list = listPresets();
  assert.ok(list.length >= 2, 'the shipped presets are listed');
  assert.equal(new Set(list.map(p => p.id)).size, list.length, 'ids are unique');

  const importSrc = fs.readFileSync(path.join(__dirname, '..', 'public/js/editor.js'), 'utf8');
  const uniq = importSrc.match(/function uniqueDashboardId\([\s\S]*?\n\}/)[0];
  const imp = importSrc.match(/function applyDashboardImport\([\s\S]*?\n\}/)[0];
  const ctx = {};
  vm.runInNewContext(`${uniq}; ${imp}; this.applyDashboardImport = applyDashboardImport;`, ctx);

  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'index.json').map(f => f.replace(/\.json$/, ''));
  assert.deepEqual(files.sort(), list.map(p => p.id).sort(), 'every preset file is listed, and every listed one exists');

  for (const p of list) {
    assert.ok(p.name && p.description, `${p.id} has a name and description`);
    const raw = fs.readFileSync(path.join(DIR, `${p.id}.json`), 'utf8');
    const cfg = JSON.parse(raw);
    assert.ok(Array.isArray(cfg.dashboards) && cfg.dashboards.length >= 1, `${p.id} has a dashboard`);
    for (const db of cfg.dashboards) {
      assert.ok(typeof db.id === 'string' && db.id, `${p.id}: dashboard id`);
      assert.ok(db.name && !/^new dashboard$/i.test(db.name), `${p.id}: dashboard has its own name`);
      const ids = new Set();
      for (const b of db.layout) {
        assert.ok(BLOCKS[b.type], `${p.id}: card type "${b.type}" is one the editor knows`);
        assert.ok(b.id && !ids.has(b.id), `${p.id}: card ids are unique`);
        ids.add(b.id);
      }
    }
    // Nothing from the site a preset was made on.
    assert.doesNotMatch(raw, /PHCN|Office use|30 kWh|since \d+ \w+ 20\d\d|postimg\.cc\/BQrq93HP/i, `${p.id}: no personal wording`);
    assert.doesNotMatch(raw, /password|token|secret|api[_-]?key/i, `${p.id}: no credentials`);
    // It imports next to existing dashboards without a clash.
    const existing = { dashboards: [{ id: cfg.dashboards[0].id, name: 'Mine', layout: [] }], activeDashboard: cfg.dashboards[0].id };
    const next = ctx.applyDashboardImport(existing, cfg, 'Append');
    assert.equal(next.dashboards.length, 1 + cfg.dashboards.length);
    assert.equal(new Set(next.dashboards.map(d => d.id)).size, next.dashboards.length, `${p.id}: ids stay unique after Append`);
    // Its picture is small and present.
    assert.ok(p.hasPreview, `${p.id} has a preview picture`);
    assert.ok(fs.statSync(path.join(DIR, 'previews', `${p.id}.webp`)).size < 80 * 1024, `${p.id}: preview under 80 KB`);
    assert.deepEqual(p.metrics, [...metricsUsed(cfg)].sort(), `${p.id}: listing carries the metrics it uses`);
  }

  // The helpers refuse anything that isn't a listed id.
  assert.equal(getPreset('../index'), null);
  assert.equal(getPreset('..%2Findex'), null);
  assert.equal(getPreset('nope'), null);
  assert.equal(getPreset(undefined), null);
  assert.equal(previewPath('../../etc/passwd'), null);
  assert.ok(previewPath(list[0].id));

  // The API.
  const app = express();
  app.use('/api/presets', require('../routes/presets'));
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => http.get({ port, path: p }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
  }).on('error', reject));
  let r = await get('/api/presets');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).map(p => p.id), list.map(p => p.id));
  r = await get(`/api/presets/${list[0].id}`);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).dashboards.length, getPreset(list[0].id).dashboards.length);
  r = await get(`/api/presets/${list[0].id}/preview`);
  assert.equal(r.status, 200);
  assert.match(r.type, /image\/webp/);
  assert.equal(r.body.subarray(0, 4).toString(), 'RIFF', 'a real webp');
  assert.equal((await get('/api/presets/nope')).status, 404);
  assert.equal((await get('/api/presets/..%2F..%2Fpackage')).status, 404, 'no path escape');
  assert.equal((await get('/api/presets/nope/preview')).status, 404);
  server.close();

  // Wiring in the editor and the server.
  assert.match(importSrc, /Add from a preset…/);
  assert.match(importSrc, /function browsePresets\(/);
  assert.match(importSrc, /applyDashboardImport\(dashboardConfig, preset, 'Append'\)/, 'a preset goes in through the same Append as an import');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /app\.use\('\/api\/presets', isAuthenticated/, 'presets need a signed-in session');
  console.log('ok - dashboard presets');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
