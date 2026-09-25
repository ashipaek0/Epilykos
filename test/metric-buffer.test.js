#!/usr/bin/env node
/**
 * test/metric-buffer.test.js — metric write queue + flush-on-read.
 *
 * Covers: queued writes are NOT visible in raw tables before flush;
 * flushMetrics() writes the whole batch (metrics + latest_metrics);
 * write-then-read sees fresh data via the read path without an explicit
 * flush (flush-on-read in modules/metrics.js); buffer overflow drops the
 * oldest entries (cap METRIC_BUFFER_CAP); mixed numeric/value_text rows
 * round-trip with type preserved.
 *
 * Isolation: modules/database.js DB_PATH is CWD-relative ('./data/energy.db'),
 * so this fixture chdirs into a fresh mkdtemp scratch cwd before requiring
 * modules — it never touches the repo's real DB (same trick as
 * metrics-manager-delete.test.js).
 *
 * Exit code: 0 on full PASS, non-zero on any assertion failure.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-metric-buffer-'));
process.chdir(tmp);

const {
  initializeDatabase, getDb, queueMetricWrite, flushMetrics, flushSync,
  clearMetricBuffer, getMetricBufferSize, startMetricAutoFlush,
  stopMetricAutoFlush, METRIC_BUFFER_CAP
} = require('../modules/database');
const { getCurrentMetrics, getMetricHistory } = require('../modules/metrics');

initializeDatabase();
const db = getDb();
const now = Math.floor(Date.now() / 1000);

// 1. Queued write NOT visible in raw tables before flush.
queueMetricWrite({ metric: 'buf_probe', value: 42.5, timestamp: now });
assert.strictEqual(getMetricBufferSize(), 1, 'buffer holds 1 queued entry');
let raw = db.prepare('SELECT value FROM metrics WHERE metric = ?').get('buf_probe');
assert.strictEqual(raw, undefined, 'queued write must NOT be visible in metrics before flush');
raw = db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('buf_probe');
assert.strictEqual(raw, undefined, 'queued write must NOT be visible in latest_metrics before flush');
console.log('PASS 1: queued write invisible before flush');

// 2. flush() writes the whole batch to both tables in one call.
for (let i = 0; i < 10; i++) {
  queueMetricWrite({ metric: 'buf_batch_' + i, value: i + 0.5, timestamp: now });
}
// +1 from test 1 still buffered
assert.strictEqual(getMetricBufferSize(), 11, 'buffer holds 11 entries');
const flushed = flushMetrics();
assert.strictEqual(flushed, 11, 'flushMetrics returns flushed count');
assert.strictEqual(getMetricBufferSize(), 0, 'buffer drained after flush');
const cnt = db.prepare("SELECT COUNT(*) c FROM metrics WHERE metric LIKE 'buf_%'").get().c;
assert.strictEqual(cnt, 11, 'all 11 rows landed in metrics');
const latest = db.prepare("SELECT COUNT(*) c FROM latest_metrics WHERE metric LIKE 'buf_%'").get().c;
assert.strictEqual(latest, 11, 'all 11 rows landed in latest_metrics');
const probe = db.prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?').get('buf_probe');
assert.strictEqual(probe.value, 42.5, 'numeric value preserved');
assert.strictEqual(probe.timestamp, now, 'timestamp preserved');
console.log('PASS 2: single flush writes full batch to both tables');

// 3. Write-then-read sees fresh data with NO explicit flush (flush-on-read).
queueMetricWrite({ metric: 'buf_fresh', value: 7.25, timestamp: now });
const cur = getCurrentMetrics(); // must drain the queue first
assert.ok(cur.buf_fresh, 'fresh write visible via getCurrentMetrics');
assert.strictEqual(cur.buf_fresh.value, 7.25, 'fresh value correct');
assert.strictEqual(getMetricBufferSize(), 0, 'read path drained the buffer');
const hist = getMetricHistory('buf_fresh', 1);
assert.ok(hist.some(r => r.value === 7.25), 'fresh write visible via getMetricHistory');
console.log('PASS 3: flush-on-read serves unflushed writes');

// 4. Overflow drops oldest (cap METRIC_BUFFER_CAP, drop-oldest with warn).
clearMetricBuffer();
assert.strictEqual(METRIC_BUFFER_CAP, 500, 'cap is 500');
for (let i = 0; i < METRIC_BUFFER_CAP + 5; i++) {
  queueMetricWrite({ metric: 'buf_ovf_' + i, value: i, timestamp: now });
}
assert.strictEqual(getMetricBufferSize(), METRIC_BUFFER_CAP, 'buffer capped at 500');
flushSync();
for (let i = 0; i < 5; i++) {
  const gone = db.prepare('SELECT metric FROM latest_metrics WHERE metric = ?').get('buf_ovf_' + i);
  assert.strictEqual(gone, undefined, `oldest entry buf_ovf_${i} must be dropped`);
}
const kept = db.prepare('SELECT value FROM latest_metrics WHERE metric = ?').get('buf_ovf_' + (METRIC_BUFFER_CAP + 4));
assert.ok(kept, 'newest overflow entry survives');
assert.strictEqual(kept.value, METRIC_BUFFER_CAP + 4, 'newest value correct');
console.log('PASS 4: overflow drops oldest, keeps newest');

// 5. Mixed value_text rows preserved (boolean + string + numeric).
clearMetricBuffer();
queueMetricWrite({ metric: 'buf_txt_bool', value: null, value_text: 'on', value_type: 'boolean', timestamp: now });
queueMetricWrite({ metric: 'buf_txt_str', value: null, value_text: 'Charging', value_type: 'string', timestamp: now });
queueMetricWrite({ metric: 'buf_txt_num', value: 123.0, timestamp: now });
flushSync();
const cur2 = getCurrentMetrics();
assert.strictEqual(cur2.buf_txt_bool.value, 'on', 'boolean text preserved');
assert.strictEqual(cur2.buf_txt_bool.type, 'boolean', 'boolean type preserved');
assert.strictEqual(cur2.buf_txt_str.value, 'Charging', 'string text preserved');
assert.strictEqual(cur2.buf_txt_str.type, 'string', 'string type preserved');
assert.strictEqual(cur2.buf_txt_num.value, 123.0, 'numeric alongside text preserved');
const trow = db.prepare('SELECT value_text, value_type FROM metrics WHERE metric = ?').get('buf_txt_bool');
assert.strictEqual(trow.value_text, 'on', 'value_text landed in history table');
assert.strictEqual(trow.value_type, 'boolean', 'value_type landed in history table');
console.log('PASS 5: mixed value_text preserved with types');

// 6. Auto-flush: single guarded timer, unref'd so the process can exit.
const t1 = startMetricAutoFlush();
const t2 = startMetricAutoFlush();
assert.strictEqual(t1, t2, 'double start returns the same timer (multiple-init guard)');
assert.strictEqual(typeof t1.unref, 'function', 'timer supports unref');
stopMetricAutoFlush();
assert.strictEqual(startMetricAutoFlush() !== t1, true, 'restart after stop creates a fresh timer');
stopMetricAutoFlush();
assert.strictEqual(flushSync(), 0, 'empty flush returns 0');
console.log('PASS 6: auto-flush guard + stop/restart + empty flush');

console.log('\nmetric-buffer.test.js: all 6 checks PASS');
