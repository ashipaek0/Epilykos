'use strict';
const checks = require('./_checks');
/**
 * The low-severity findings and the small bugs from the security and debugging review: quotes escaped in HTML text, secrets kept out of the
 * access log and off command lines, HSTS over HTTPS, a share of the push slots kept for the admin, the update timer that must not retry for
 * ever, and the unused Tuya cloud route gone.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-low-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const repo = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(repo, f), 'utf8');

(async () => {
  // ── Quotes in escaped text ──
  const { escapeHtml } = await import(path.join(repo, 'public/js/utils.js'));
  const settingsFn = new Function('return ' + /function escapeHtml\(str\) \{[\s\S]*?\n\}/.exec(read('public/settings.js'))[0])();
  for (const fn of [escapeHtml, settingsFn]) {
    assert.strictEqual(fn(`a"b'c<d>&e`), 'a&quot;b&#39;c&lt;d&gt;&amp;e', 'every character that can end an attribute or open markup');
    assert.strictEqual(fn(null), ''); assert.strictEqual(fn(undefined), ''); assert.strictEqual(fn(0), '0'); assert.strictEqual(fn(12.5), '12.5');
    const attr = `<input value="${fn('x" onfocus="alert(1)')}">`;
    assert.strictEqual(attr, '<input value="x&quot; onfocus=&quot;alert(1)">', 'a quote in a value does not end the attribute');
  }
  for (const f of ['public/js/settings-shell.js', 'public/js/editor.js']) assert.match(read(f), /replace\(\/'\/g, ?'&#39;'\)/, `${f} escapes a single quote too`);
  console.log('ok - HTML escaping covers quotes in every helper');

  // ── The access log keeps secrets out ──
  const { redactUrl } = require('../modules/logRedact');
  assert.strictEqual(redactUrl('/api/pvoutput/webhook/abcdef0123456789abcdef?sid=1'), '/api/pvoutput/webhook/[hidden]?sid=1');
  assert.strictEqual(redactUrl('/api/pvoutput/webhook?token=SECRET&sid=1'), '/api/pvoutput/webhook?token=[hidden]&sid=1');
  assert.strictEqual(redactUrl('/x?a=1&API_KEY=k&password=p&code=123456&b=2#frag'), '/x?a=1&API_KEY=[hidden]&password=[hidden]&code=[hidden]&b=2#frag');
  assert.strictEqual(redactUrl('/x?%74oken=SECRET'), '/x?%74oken=[hidden]', 'an encoded name is read before it is compared');
  assert.strictEqual(redactUrl('/api/metrics/history?metric=pv_power&hours=24'), '/api/metrics/history?metric=pv_power&hours=24', 'ordinary queries are untouched');
  assert.strictEqual(redactUrl(undefined), ''); assert.strictEqual(redactUrl('/plain'), '/plain');
  assert.match(read('server.js'), /morgan\.token\('url', req => require\('\.\/modules\/logRedact'\)\.redactUrl\(req\.originalUrl \|\| req\.url\)\)/);
  console.log('ok - the access log hides tokens in a query and in the webhook address');

  // ── HSTS ──
  const mw = require('../modules/securityHeaders').middleware();
  const run = req => { const h = {}; mw(req, { setHeader: (k, v) => { h[k] = v; } }, () => {}); return h; };
  assert.strictEqual(run({ secure: true })['Strict-Transport-Security'], 'max-age=15552000');
  assert.ok(!/includeSubDomains|preload/.test(run({ secure: true })['Strict-Transport-Security']));
  assert.strictEqual(run({ secure: false })['Strict-Transport-Security'], undefined, 'not over plain HTTP, where it would mean nothing');
  assert.ok(run({ secure: false })['Content-Security-Policy'], 'the other headers are unchanged');
  console.log('ok - HSTS only over HTTPS');

  // ── A share of the push slots stays free for the admin ──
  require('../modules/database').initializeDatabase();
  const store = require('../modules/notifications/store');
  store.ensureSchema && store.ensureSchema();
  const sub = i => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${i}`, keys: { p256dh: 'p', auth: 'a' } });
  for (let i = 0; i < store.MAX_VISITOR_DEVICES; i++) assert.ok(store.addDevice(sub(i), { label: 'v' + i, userAgent: 'ua', visitor: true }).created, `visitor ${i}`);
  assert.deepStrictEqual(store.addDevice(sub(1000), { label: 'late', userAgent: 'ua', visitor: true }), { full: true }, 'a visitor cannot take the admin\'s slots');
  assert.ok(store.addDevice(sub(0), { label: 'again', userAgent: 'ua', visitor: true }).created === false, 'a visitor already listed is refreshed, not refused');
  for (let i = 0; i < store.MAX_DEVICES - store.MAX_VISITOR_DEVICES; i++) assert.ok(store.addDevice(sub(2000 + i), { label: 'a' + i, userAgent: 'ua' }).created, `admin ${i}`);
  assert.deepStrictEqual(store.addDevice(sub(3000), { label: 'x', userAgent: 'ua' }), { full: true }, 'the list is still capped as a whole');
  assert.strictEqual(store.getDevices().filter(d => d.visitor === true).length, store.MAX_VISITOR_DEVICES);
  assert.ok(!('visitor' in store.publicDevice(store.getDevices()[0])), 'the flag is not shown');
  assert.match(read('modules/notifications/routes.js'), /visitor: !\(req\.session && req\.session\.authenticated\)/, 'only someone not signed in counts as a visitor');
  console.log('ok - visitors can take at most 40 of the 50 push slots');

  // ── Tuya: the local key and the token are not on the command line ──
  const childProcess = require('child_process');
  const seen = [];
  childProcess.execFile = (file, args, opts, cb) => { seen.push({ args, env: opts && opts.env }); cb(null, JSON.stringify({ '1': true, token: 1 }), ''); };
  const db = require('../modules/database');
  db.setConfig('tuya_devices', JSON.stringify([{ name: 'Plug', dev_id: 'bf1', address: '10.0.0.2', local_key: 'LOCAL-KEY-12345678', enabled: true, version: '3.3', dps: { Switch: '1' } }]));
  const tuya = require('../modules/tuya');
  await tuya.testTuyaDevice({ dev_id: 'bf1', address: '10.0.0.2', local_key: 'LOCAL-KEY-12345678', version: '3.3' });
  await tuya.executeTuyaAction('Plug', 1, true).catch(() => {});
  await tuya.fetchDevicesOAuth({ access_token: 'ACCESS-TOKEN-ABCDEFGH', uid: 'u' });
  assert.ok(seen.length >= 3, 'the bridge was called');
  for (const call of seen) {
    const line = call.args.join(' ');
    assert.ok(!line.includes('LOCAL-KEY-12345678') && !line.includes('ACCESS-TOKEN-ABCDEFGH'), 'no secret on the command line: ' + line);
  }
  assert.strictEqual(seen[0].args[5], '@env'); assert.strictEqual(seen[0].env.TUYA_LOCAL_KEY, 'LOCAL-KEY-12345678', 'the key travels in the environment');
  assert.ok(seen.some(c => c.env && /ACCESS-TOKEN-ABCDEFGH/.test(c.env.TUYA_TOKEN_INFO || '')), 'so does the OAuth token');
  // A failure never echoes the key, which is now in the environment, not the arguments.
  childProcess.execFile = (file, args, opts, cb) => { const e = new Error('x'); e.code = 1; cb(e, '', 'Traceback\nValueError: bad key LOCAL-KEY-12345678 here'); };
  const failed = await tuya.testTuyaDevice({ dev_id: 'bf1', address: '10.0.0.2', local_key: 'LOCAL-KEY-12345678', version: '3.3' });
  assert.ok(!JSON.stringify(failed).includes('LOCAL-KEY-12345678'), 'the error does not show the key: ' + JSON.stringify(failed));
  const py = require('child_process').spawnSync('python3', ['-I', '-c', `
import importlib.util, os, sys
sys.argv = ['x']
spec = importlib.util.spec_from_file_location('bridge', ${JSON.stringify(path.join(repo, 'modules/tuya_bridge.py'))}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
os.environ['TUYA_LOCAL_KEY'] = 'from-env'
assert m._secret('@env', 'TUYA_LOCAL_KEY') == 'from-env'
assert 'TUYA_LOCAL_KEY' not in os.environ, 'taken out of the environment once read'
assert m._secret('plain-key', 'TUYA_LOCAL_KEY') == 'plain-key', 'an older caller that passes the key as an argument still works'
print('py ok')`], { encoding: 'utf8' });
  assert.match(py.stdout, /py ok/, py.stdout + py.stderr);
  assert.ok(!/fetchCloudDevices|tuya-cloud-fetch/.test(read('modules/tuya.js') + read('routes/tuya.js')), 'the cloud-secret route that nothing used (and whose script action was gone) is removed');
  console.log('ok - Tuya keys and tokens travel in the environment, not on the command line');

  // ── The update timer ends even when reconcile keeps failing ──
  const { mock } = require('node:test');
  const dockerUpdate = require('../modules/dockerUpdate');
  let calls = 0, unhandled = 0;
  process.on('unhandledRejection', () => { unhandled++; });
  dockerUpdate.applying = () => true;
  dockerUpdate.reconcile = async () => { calls++; throw new Error('docker said no'); };
  mock.timers.enable({ apis: ['setInterval'] });
  const updates = require('../modules/updates');
  updates.start();
  for (let i = 0; i < 60; i++) { mock.timers.tick(15000); await new Promise(r => setImmediate(r)); }
  mock.timers.reset();
  updates.stop();
  assert.strictEqual(calls, 41, `a failing reconcile is tried 41 times, then stops (it ran ${calls})`);
  assert.strictEqual(unhandled, 0, 'and never rejects unhandled');
  console.log('ok - a failing update reconcile ends after its limit');

  // ── Smaller ──
  assert.match(read('routes/remote.js'), /cloudflared\.isInstalled\(\)\.then\([\s\S]*?\}\)\.catch\(e => logger\.warn\(`\[cloudflared\] could not start/);
  assert.match(read('modules/history.js'), /role_metrics is not valid JSON/);
  console.log('ok - the Cloudflare startup and a corrupt role_metrics are logged');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
