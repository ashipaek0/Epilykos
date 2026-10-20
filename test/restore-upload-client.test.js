'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function fixture() {
  const timers = [], requests = [], chunks = [], slices = [], listeners = {};
  const options = { status: {}, progress: { removeAttribute() {} }, cancel: { addEventListener(_, cb) { listeners.cancel = cb; } }, row: {}, restore: {}, backup: {}, onSelected() { options.selected = (options.selected || 0) + 1; } };
  const job = { id: 'job', phase: 'uploading', bytes: 10, received: 0, chunkBytes: 4 };
  const window = { EpilykosCsrf: { token: async () => 'fixture-token', invalidate() {} }, addEventListener(name, callback) { listeners[name] = callback; }, removeEventListener(name) { delete listeners[name]; }, fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => init?.method === 'POST' ? { ...job } : { status: { ...job, phase: 'selected' } } }; }, XMLHttpRequest: class {
    constructor() { this.upload = {}; chunks.push(this); }
    open() {} setRequestHeader(name, value) { (this.headers ||= {})[name] = value; } send(slice) { this.slice = slice; } abort() { this.onabort(); }
    complete() { this.status = 200; job.received = this.slice.end; if (job.received === job.bytes) job.phase = 'preparing'; this.responseText = JSON.stringify(job); this.onload(); }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/restore-upload.js'), 'utf8'), { window, setTimeout(cb, ms) { timers.push({ cb, ms }); return timers.length; }, clearTimeout() {} });
  const client = window.EpilykosRestoreUploads.connect(options);
  const file = { size: 10, name: 'backup.db', slice(start, end) { slices.push([start, end]); return { start, end }; } };
  return { client, file, options, requests, chunks, slices, timers, listeners, job, window };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('duplicate start is suppressed while DATA admission is pending', async () => {
  const f = fixture(); const first = f.client.start(f.file), second = f.client.start(f.file);
  assert.equal(f.options.restore.disabled, true); assert.equal(f.options.backup.disabled, true);
  await tick(); assert.equal(f.requests.length, 1); assert.equal(f.chunks.length, 1);
  await f.listeners.cancel(); await Promise.all([first, second]); f.client.dispose();
});
test('File slices bound each request and progress includes accepted bytes', async () => {
  const f = fixture(), pending = f.client.start(f.file); await tick();
  assert.equal(f.chunks[0].headers['X-CSRF-Token'], 'fixture-token');
  f.chunks[0].complete(); await tick(); f.timers.shift().cb(); await tick();
  f.chunks[1].upload.onprogress({ loaded: 2 }); assert.equal(f.options.progress.value, 6);
  f.chunks[1].complete(); await tick(); f.timers.shift().cb(); await tick();
  f.chunks[2].complete(); await pending;
  assert.deepEqual(f.slices, [[0,4],[4,8],[8,10]]); assert.match(f.options.status.textContent, /Validating/); f.client.dispose();
});
test('reconnecting to a previous selected result does not reload repeatedly', async () => {
  const f = fixture(); await f.client.refresh(); assert.equal(f.options.selected, undefined); assert.equal(f.options.row.hidden, true); assert.equal(f.options.restore.disabled, false); f.client.dispose();
});

test('failed admission after a previous terminal result restores controls', async () => {
  const f = fixture(); await f.client.refresh();
  f.window.fetch = async () => ({ ok: false, status: 507, json: async () => ({ error: 'Not enough DATA space' }) });
  await f.client.start(f.file);
  assert.match(f.options.status.textContent, /Not enough DATA space/);
  assert.equal(f.options.restore.disabled, false); assert.equal(f.options.backup.disabled, false); f.client.dispose();
});
test('expired authorization stops outage polling and resumes on return after sign-in', async () => {
  const f = fixture(), pending = f.client.start(f.file); await tick();
  f.chunks[0].complete(); await tick(); f.timers.shift().cb(); await tick();
  f.chunks[1].complete(); await tick(); f.timers.shift().cb(); await tick(); f.chunks[2].complete(); await pending;
  f.window.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) });
  f.timers.shift().cb(); await tick();
  assert.match(f.options.status.innerHTML || f.options.status.textContent, /Sign in/);
  assert.doesNotMatch(f.options.status.textContent, /Waiting for Epilykos to reconnect/);
  assert.equal(f.timers.length, 0); assert.equal(f.options.cancel.disabled, true);
  f.window.fetch = async () => ({ ok: true, json: async () => ({ status: { ...f.job, phase: 'selected' } }) });
  f.listeners.focus(); await tick(); assert.match(f.options.status.textContent, /Backup restored/);
  assert.equal(f.options.restore.disabled, false); f.client.dispose(); assert.equal(f.listeners.focus, undefined);
});
test('sign-in after unauthorized creation restores controls even with no recorded job', async () => {
  const f = fixture();
  f.window.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) });
  await f.client.start(f.file); assert.equal(f.options.restore.disabled, true);
  f.window.fetch = async () => ({ ok: true, json: async () => ({ status: null }) });
  f.listeners.focus(); await tick(); assert.equal(f.options.restore.disabled, false); assert.equal(f.options.backup.disabled, false); f.client.dispose();
});
