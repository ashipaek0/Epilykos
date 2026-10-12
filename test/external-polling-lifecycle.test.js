'use strict';
const checks = require('./_checks');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-external-lifecycle-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');
const database = require('../modules/database');
database.initializeDatabase();
const setSource = name => database.setConfig('external_sources', JSON.stringify([{ enabled: true, name, url: `http://${name}.example`, mappings: { external_watts: 'watts' } }]));
const requests = [], timers = new Map();
let nextTimer = 0;
const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
global.setInterval = (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; };
global.clearInterval = id => timers.delete(id);
const utils = require('../modules/utils');
utils.assertSafeFetchUrl = async url => ({ ok: true, url });
utils.safeFetch = (url, init) => new Promise(resolve => requests.push({ url, signal: init.signal, resolve }));
const external = require('../modules/external');
const settle = () => new Promise(r => setImmediate(r));
const reply = (request, watts) => request.resolve({ ok: true, json: async () => ({ watts }) });
const read = () => { database.flushMetrics(); return database.getDb().prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('external_watts')?.value; };

(async () => {
  try {
    setSource('first');
    external.startExternalPolling();
    await settle();
    const firstTimer = [...timers.values()][0];
    for (let i = 0; i < 5; i++) firstTimer.fn();
    const direct = external.pollExternalSources();
    await settle();
    assert.strictEqual(requests.length, 1, 'ticks and direct calls cannot overlap a slow poll');
    reply(requests[0], 10);
    await direct;
    assert.strictEqual(read(), 10);
    firstTimer.fn();
    await settle();
    assert.strictEqual(requests.length, 2, 'the next tick runs once the previous poll finishes');

    // Retire a poll even when its response body ignores cancellation. A restart
    // waits for it and drops its values instead of overwriting the new config.
    let finishBody;
    requests[1].resolve({ ok: true, json: () => new Promise(r => { finishBody = r; }) });
    await settle();
    setSource('second');
    external.restartExternalPolling();
    await settle();
    assert.strictEqual(requests[1].signal.aborted, true);
    assert.strictEqual(requests.length, 2, 'restart waits for an old request that ignores abort');
    assert.strictEqual(timers.size, 1);
    firstTimer.fn();
    finishBody({ watts: 99 });
    await settle();
    assert.strictEqual(read(), 10, 'a retired response body does not write metrics');
    assert.strictEqual(requests.length, 3);
    assert.strictEqual(requests[2].url, 'http://second.example');
    reply(requests[2], 20);
    await settle();
    assert.strictEqual(read(), 20);

    const currentTimer = [...timers.values()][0];
    currentTimer.fn();
    await settle();
    external.stopExternalPolling();
    assert.strictEqual(timers.size, 0);
    assert.strictEqual(requests[3].signal.aborted, true);
    reply(requests[3], 100);
    await settle();
    currentTimer.fn();
    await settle();
    assert.strictEqual(requests.length, 4, 'stopped and retired timer callbacks cannot restart polling');
    assert.strictEqual(read(), 20);

    // Multiple restarts while cancelling one request start only the last config.
    external.startExternalPolling();
    await settle();
    setSource('third'); external.restartExternalPolling();
    setSource('fourth'); external.restartExternalPolling();
    reply(requests[4], 200);
    await settle();
    assert.strictEqual(requests.length, 6);
    assert.strictEqual(requests[5].url, 'http://fourth.example');
    reply(requests[5], 30);
    await settle();
    assert.strictEqual(read(), 30);
    console.log('ok - external polls do not overlap and cancelled responses cannot write after restart/stop');
    checks.done();
  } finally {
    external.stopExternalPolling();
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    database.getDb().close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
