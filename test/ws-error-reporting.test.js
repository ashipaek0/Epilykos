#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/ws-manager.js'), 'utf8');
const script = source.replace(/^export /gm, '');
const sockets = [];
const timers = [];
const errors = [];
const debug = [];
class StubWebSocket {
  constructor(url) { this.url = url; sockets.push(this); }
  close() {}
}
const context = {
  window: { location: { protocol: 'http:', host: 'example.test' } },
  WebSocket: StubWebSocket,
  console: { error: (...args) => errors.push(args), debug: (...args) => debug.push(args), warn() {} },
  setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
  clearTimeout() {}, Math,
  indexedDB: {}, navigator: {}, document: {}, self: {}
};
vm.runInNewContext(script, context);
let openCount = 0;
context.connectWebSocket({ onMessage() {}, onOpen() { openCount++; } });
const first = sockets[0];
const rawEvent = { type: 'error', target: first };
first.onerror(rawEvent);
first.onerror(rawEvent);
assert.strictEqual(errors.length, 1, 'errors in one outage are logged once');
assert.strictEqual(errors[0].length, 1, 'log is one concise string, not an event');
assert.strictEqual(errors[0][0], '[WSManager] Connection failed; retrying');
first.onclose();
assert.strictEqual(timers.length, 1, 'close still schedules reconnect');
assert.strictEqual(timers[0].delay >= 1000 && timers[0].delay < 1300, true);
timers[0].fn();
const second = sockets[1];
second.onopen();
assert.strictEqual(openCount, 1, 'onOpen callback runs when the WebSocket opens');
second.onerror(rawEvent);
assert.strictEqual(errors.length, 2, 'open resets suppression for a later outage');
assert.deepStrictEqual(errors[1], ['[WSManager] Connection failed; retrying']);
console.log('PASS ws-error-reporting: outage logging and reconnect behavior');
