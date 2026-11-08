'use strict';
const checks = require('./_checks');
/**
 * BMS read intervals, with made-up values: every battery (Bluetooth or wired) is read on its
 * own `poll_interval`; the pollers tick and read what is due; a bank is computed on the
 * shortest interval of its batteries; readings stay fresh for twice the battery's interval
 * (at least a minute); and the settings page has the field and saves it.
 */
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-bmsint-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'key');

const hits = { A: 0, B: 0 };
const bridge = http.createServer((q, s) => {
  s.setHeader('content-type', 'application/json');
  const u = decodeURIComponent(q.url);
  if (u.includes('EE:0A')) { hits.A++; return s.end(JSON.stringify({ voltage: 52, battery_level: 80, design_capacity: 100 })); }
  if (u.includes('EE:0B')) { hits.B++; return s.end(JSON.stringify({ voltage: 53, battery_level: 90, design_capacity: 100 })); }
  s.end('[]');
});

bridge.listen(0, '127.0.0.1', async () => {
  try {
    process.env.BMS_BRIDGE_URL = `http://127.0.0.1:${bridge.address().port}`;
    const database = require('../modules/database');
    database.initializeDatabase();
    const db = database.getDb();
    const iv = require('../modules/bmsInterval');
    const bms = require('../modules/bms');
    const agg = require('../modules/bmsAggregator');

    // --- the helper ---
    assert.equal(iv.deviceInterval({ poll_interval: 10 }), 10);
    assert.equal(iv.deviceInterval({ poll_interval: '45' }), 45, 'a saved string works');
    assert.equal(iv.deviceInterval({}), 30, 'no interval: 30');
    assert.equal(iv.deviceInterval({ poll_interval: 1 }), iv.MIN_S, 'not faster than 5 s');
    assert.equal(iv.deviceInterval({ poll_interval: 99999 }), iv.MAX_S);
    database.setConfig('bms_poll_interval', '20');
    assert.equal(iv.deviceInterval({}), 20, 'a battery with none uses the older setting');
    database.setConfig('bms_poll_interval', '');
    assert.equal(iv.stalenessFor({ poll_interval: 10 }), 60, 'never fresher than a minute');
    assert.equal(iv.stalenessFor({ poll_interval: 120 }), 240, 'twice the interval');
    const t = iv.createDueTracker(), d = { name: 'x', poll_interval: 10 };
    assert.ok(t.isDue(d, 0), 'never tried: due'); t.mark(d, 0);
    assert.ok(!t.isDue(d, 5000)); assert.ok(t.isDue(d, 9600), 'due a little early for timer jitter'); assert.ok(t.isDue(d, 10000));
    console.log('ok - intervals: own, default, limits, freshness window, due tracking');

    // --- the poller reads what is due ---
    database.setConfig('bms_devices', JSON.stringify([
      { name: 'Fast', enabled: true, address: 'AA:BB:CC:DD:EE:0A', poll_interval: 5, mappings: {} },
      { name: 'Slow', enabled: true, address: 'AA:BB:CC:DD:EE:0B', poll_interval: 120, mappings: {} }]));
    database.setConfig('bms_banks', JSON.stringify([{ name: 'Pair', enabled: true, devices: [{ name: 'Fast' }, { name: 'Slow' }],
      functions: [{ output: 'pair_v', fn: 'mean', sources: { Fast: 'voltage', Slow: 'voltage' } }] }]));
    const realNow = Date.now; let skew = 0;
    Date.now = () => realNow() + skew * 1000;
    const bankStamp = () => { database.flushMetrics(); return db.prepare("SELECT timestamp FROM latest_metrics WHERE metric = 'bank_Pair_last_update'").get(); };
    const lastUpdate = () => { database.flushMetrics(); return db.prepare("SELECT value FROM latest_metrics WHERE metric = 'bank_Pair_last_update'").get()?.value; };

    await bms.pollBMS({ dueOnly: true });
    assert.deepEqual(hits, { A: 1, B: 1 }, 'the first tick reads every battery');
    const first = lastUpdate(); assert.ok(first > 0, 'the bank is computed after the first reads');
    await bms.pollBMS({ dueOnly: true });
    assert.deepEqual(hits, { A: 1, B: 1 }, 'the next tick reads nothing: nobody is due');
    skew = 6;
    await bms.pollBMS({ dueOnly: true });
    assert.deepEqual(hits, { A: 2, B: 1 }, 'after 6 s only the 5 s battery is read');
    skew = 60;
    await bms.pollBMS({ dueOnly: true });
    assert.deepEqual(hits, { A: 3, B: 1 }, 'the 120 s battery keeps waiting');
    skew = 125;
    await bms.pollBMS({ dueOnly: true });
    assert.deepEqual(hits, { A: 4, B: 2 }, 'after its interval it is read again');
    await bms.pollBMS();
    assert.deepEqual(hits, { A: 5, B: 3 }, 'called directly, every battery is read');
    console.log('ok - the BMS poller reads each battery on its own interval');

    // --- the bank follows its fastest battery ---
    skew = 125; await bms.pollBMS({ dueOnly: true });
    const before = lastUpdate();
    skew = 127; await bms.pollBMS({ dueOnly: true });       // 2 s: the bank is not due, no battery is
    assert.equal(lastUpdate(), before, 'not recomputed before its interval');
    skew = 140; await bms.pollBMS({ dueOnly: true });
    assert.ok(lastUpdate() >= before, 'recomputed after it');
    console.log('ok - a bank is computed on the shortest interval of its batteries');

    // --- freshness follows each battery's interval ---
    Date.now = realNow;
    const nowS = Math.floor(realNow() / 1000);
    const put = (metric, age) => db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)').run(metric, 50, nowS - age);
    put('bms_Old_voltage', 100);              // read 100 s ago
    const bank = { name: 'Age', enabled: true, devices: [{ name: 'Old' }], functions: [{ output: 'age_v', fn: 'sum', sources: { Old: 'voltage' } }] };
    database.setConfig('bms_devices', JSON.stringify([{ name: 'Old', enabled: true, address: 'AA:BB:CC:DD:EE:0C', poll_interval: 30 }]));
    await agg.computeBankAggregates(bank, 30); database.flushMetrics();
    assert.equal(db.prepare("SELECT value FROM latest_metrics WHERE metric = 'bank_age_v'").get(), undefined, 'every 30 s: 100 s old is stale');
    database.setConfig('bms_devices', JSON.stringify([{ name: 'Old', enabled: true, address: 'AA:BB:CC:DD:EE:0C', poll_interval: 120 }]));
    await agg.computeBankAggregates(bank, 30); database.flushMetrics();
    assert.equal(db.prepare("SELECT value FROM latest_metrics WHERE metric = 'bank_age_v'").get().value, 50, 'every 120 s: 100 s old is fresh');
    assert.equal(agg.isDeviceFresh({ v: { value: 1, timestamp: nowS - 100 } }, iv.stalenessForName('Old')), true);
    assert.equal(iv.stalenessForName('Not Configured'), 60, 'an unknown battery keeps the minute');
    console.log('ok - readings stay fresh for twice the battery\'s own interval');

    // --- the settings page, the wired poller and the connection dot ---
    const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
    const js = read('public/settings.js'), wired = read('modules/bmsWired.js'), srv = read('server.js');
    assert.equal((js.match(/name="bms_devices\[\$\{idx\}\]\[poll_interval\]"/g) || []).length, 2, 'both the Bluetooth and the wired card have the field');
    assert.match(js, /dev\.transport = 'bluetooth';\s+dev\.poll_interval = Math\.min\(3600, Math\.max\(5,/);
    assert.match(js, /dev\.timeout = parseInt\(card\.querySelector\('input\[name\$="\[timeout\]"\]'\)\.value\) \|\| 5000;\s+dev\.poll_interval = Math\.min\(3600/, 'wired batteries save it');
    assert.match(wired, /dueOnly && !due\.isDue\(device\)/, 'the wired poller reads what is due');
    assert.match(wired, /setInterval\(run, TICK_S \* 1000\)/);
    assert.match(srv, /stalenessForName\(device\.name\)/); assert.match(srv, /bmsInterval'\)\.stalenessForName\(name\)/, 'the connection dot and Test bank use each battery\'s interval');
    console.log('ok - settings field, wired poller, connection dot');
    checks.done();
  } catch (err) { console.error(err); process.exitCode = 1; }
  finally { bridge.close(); setTimeout(() => process.exit(process.exitCode || 0), 50); }
});
