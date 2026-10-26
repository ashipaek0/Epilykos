'use strict';
const checks = require('./_checks');
// A BMS called "135 Ah" is stored by the pollers as bms_135_Ah_<key> (every
// character outside A-Z a-z 0-9 _ becomes an underscore). The settings page
// (metrics to map), the connection dot and the combined banks read it back
// under the same name; looking for "bms_135 Ah_" found nothing, so such a
// device showed no metrics to map, never looked connected and a bank
// built from it showed nothing.
const assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs');
const db = require('../modules/database');
db.initializeDatabase({ filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epk-bms-name-')), 'energy.db') });
const agg = require('../modules/bmsAggregator');

const now = Math.floor(Date.now() / 1000);
const store = (device, key, value) => db.queueMetricValue(`bms_${device}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_'), value, now);
store('135 Ah', 'voltage', 52.1); store('135 Ah', 'current', -4.5);
store('300 Ah', 'voltage', 51.9);
store('plain', 'voltage', 12.6);
store('JBD-AP21S001', 'soc', 88);

const read = name => Object.fromEntries(Object.entries(agg.readLatestBmsMetrics(name)).map(([k, v]) => [k, v.value]));
assert.deepEqual(read('135 Ah'), { voltage: 52.1, current: -4.5 }, 'a name with a space is found');
assert.deepEqual(read('300 Ah'), { voltage: 51.9 }, 'and is not mixed up with another device');
assert.deepEqual(read('plain'), { voltage: 12.6 }, 'a plain name still works');
assert.deepEqual(read('JBD-AP21S001'), { soc: 88 }, 'dashes are turned into underscores too');
console.log('ok - metrics are read under the name they were stored with');

assert.deepEqual(agg.getAvailableSourceKeys('135 Ah').map(k => k.key), ['current', 'voltage'], 'the mapping list offers them');
assert.equal(agg.isDeviceFresh(agg.readLatestBmsMetrics('135 Ah'), 60), true, 'the device shows as connected');
console.log('ok - the metrics to map and the connected state follow');
checks.done();
