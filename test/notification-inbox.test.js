'use strict';
// The notification inbox (the bell): links, threads, the store, the dispatcher's one-row-per-alert, the API,
// and the bell's own helpers.
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-inbox-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const express = require('express');
require('../modules/database').initializeDatabase();
const store = require('../modules/notifications/store');
const links = require('../modules/notifications/links');
const dispatcher = require('../modules/notifications/dispatcher');
const webpush = require('../modules/notifications/channels/webpush');
const routes = require('../modules/notifications/routes');
store.ensureSchema();

(async () => {
  // Links: every catalogued event has a page, and only a path on this site
  const { EVENT_TYPES } = require('../modules/notifications/events');
  for (const type of Object.keys(EVENT_TYPES)) {
    const p = links.pathFor(type);
    assert.ok(p.startsWith('/') && !p.startsWith('//'), `${type} → ${p}`);
  }
  assert.equal(links.pathFor('update.available'), '/settings#updates');
  assert.equal(links.pathFor('backup.cloud_failed'), '/settings#backup');
  assert.equal(links.pathFor('something.unknown'), '/');
  assert.equal(links.threadFor('grid.off'), links.threadFor('grid.on'));
  assert.equal(links.threadFor('source.offline', 'ha'), 'source-ha');
  assert.equal(links.threadFor('update.available'), null);
  assert.ok(links.resolvesThread('grid.on') && !links.resolvesThread('grid.off'));

  // Push payload: the path is what a click opens
  const payload = JSON.parse(webpush.payloadFor({ title: 't', body: 'b', severity: 'warning', tag: 'x', path: '/settings#backup', url: 'https://example.com/' }));
  assert.equal(payload.url, '/settings#backup');
  assert.equal(JSON.parse(webpush.payloadFor({ title: 't', body: 'b', url: 'https://example.com/' })).url, 'https://example.com/');

  // Store: add, read, resolve, cap, clear
  const a = store.addInbox({ severity: 'critical', title: 'Grid outage', body: 'off', path: '/', event_type: 'grid.off', thread: 'grid' });
  const b = store.addInbox({ severity: 'info', title: 'Update', body: 'x', path: '/settings#updates', event_type: 'update.available' });
  let box = store.getInbox();
  assert.equal(box.unread, 2); assert.equal(box.items[0].id, b); assert.equal(box.items[0].read, false);
  const c = store.addInbox({ severity: 'info', title: 'Grid back', body: 'on', path: '/', event_type: 'grid.on', thread: 'grid', resolves: 'grid' });
  box = store.getInbox();
  assert.equal(box.items.find(i => i.id === a).resolved, true, 'the outage is resolved by the restore');
  assert.equal(box.items.find(i => i.id === c).resolved, false);
  assert.equal(store.markInboxRead([a, 'nonsense', -5.5]), 1);
  assert.equal(store.getInbox().unread, 2);
  assert.equal(store.markInboxRead('all'), 2);
  assert.equal(store.getInbox().unread, 0);
  for (let i = 0; i < 230; i++) store.addInbox({ title: 'n' + i });
  assert.ok(store.getInbox(500).items.length <= 200, 'capped');
  store.clearInbox();
  assert.equal(store.getInbox().items.length, 0);
  store.addInbox({ severity: 'weird', title: 'x'.repeat(500), path: '/' });
  assert.equal(store.getInbox().items[0].severity, 'info');
  assert.equal(store.getInbox().items[0].title.length, 200);
  store.clearInbox();

  // Dispatcher: one inbox row per alert, however many channels; quiet hours still list it, flagged
  store.saveSettings({ ...store.getSettings(), enabled: true, base_url: 'https://home.example.com' });
  store.saveChannels([
    { id: 'c1', type: 'webhook', name: 'Hook 1', enabled: true, config: { webhook_url: 'https://hooks.example.invalid/a' } },
    { id: 'c2', type: 'webhook', name: 'Hook 2', enabled: true, config: { webhook_url: 'https://hooks.example.invalid/b' } },
  ]);
  const sent = [];
  const realSend = dispatcher.CHANNEL_TYPES.webhook.send;
  dispatcher.CHANNEL_TYPES.webhook.send = async (config, msg) => { sent.push(msg); };
  await dispatcher.deliver({ title: 'Backup failed', body: 'x', severity: 'warning', path: '/settings#backup', event: 'backup.cloud_failed', rule: 'R' }, ['c1', 'c2'], { id: 'r1', name: 'R' });
  assert.equal(store.getInbox().items.length, 1, 'two channels, one inbox row');
  assert.equal(store.getInbox().items[0].path, '/settings#backup');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, 'https://home.example.com/settings#backup', 'other services get the full address of the right page');
  const s = store.getSettings();
  const now = new Date(); const hh = n => String((n + 24) % 24).padStart(2, '0');
  store.saveSettings({ ...s, quiet_hours: { enabled: true, start: hh(now.getHours() - 1) + ':00', end: hh(now.getHours() + 2) + ':00' } });
  await dispatcher.deliver({ title: 'Quiet one', body: 'x', severity: 'info', path: '/' }, ['c1'], { id: 'r1', name: 'R' });
  const held = store.getInbox().items.find(i => i.title === 'Quiet one');
  assert.ok(held && held.held === true, 'held back by quiet hours but still in the inbox');
  assert.equal(sent.length, 2, 'and not sent');
  store.saveSettings({ ...s, enabled: false });
  const before = store.getInbox().items.length;
  await dispatcher.deliver({ title: 'Off', body: 'x', severity: 'info', path: '/' }, ['c1'], { id: 'r1', name: 'R' });
  assert.equal(store.getInbox().items.length, before, 'notifications off: nothing');
  await dispatcher.deliver({ title: 'Test', body: 'x', severity: 'info' }, ['c1'], null, { force: true });
  assert.equal(store.getInbox().items.length, before, 'a test send is not an alert');
  dispatcher.CHANNEL_TYPES.webhook.send = realSend;

  // The API
  store.clearInbox();
  const id = store.addInbox({ severity: 'warning', title: 'T', body: 'B', path: '/settings#sources' });
  const app = express(); app.use(express.json()); app.use('/api/notifications', routes.createRouter());
  const server = await new Promise(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/notifications' + p, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  let r = await call('GET', '/inbox');
  assert.equal(r.status, 200); assert.equal(r.body.unread, 1); assert.equal(r.body.items[0].id, id);
  r = await call('POST', '/inbox/read', { ids: [id] });
  assert.equal(r.body.unread, 0);
  r = await call('POST', '/inbox/read', {});
  assert.equal(r.status, 200);
  r = await call('DELETE', '/inbox');
  assert.equal(r.body.unread, 0);
  assert.equal((await call('GET', '/inbox')).body.items.length, 0);
  server.close();

  // The bell's helpers
  const bell = await import(pathToFileURL(path.join(__dirname, '..', 'public/js/notification-bell.js')).href);
  const t = Math.floor(Date.now() / 1000);
  assert.equal(bell.ago(t), 'just now');
  assert.equal(bell.ago(t - 300), '5 min ago');
  assert.equal(bell.ago(t - 7200), '2 h ago');
  assert.equal(bell.ago(t - 3 * 86400), '3 d ago');
  assert.equal(bell.safePath('/settings#backup'), '/settings#backup');
  assert.equal(bell.safePath('//evil.example'), '/');
  assert.equal(bell.safePath('https://evil.example'), '/');
  assert.equal(bell.safePath('/\\evil'), '/');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/notification-bell.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/, 'alert texts are set as text');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public/js/dashboard.js'), 'utf8');
  assert.match(dash, /initNotificationBell/);
  assert.ok(dash.indexOf('initNotificationBell(') > dash.indexOf('signedIn = true'), 'only after the session check');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
