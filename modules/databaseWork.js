'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
let generation = 0;

// Each request or background engine owns its async lineage. A restore retires
// that lineage without allowing delayed responses to write into a new DB.
function run(fn) { return context.run({ generation }, fn); }
function isCurrent() { const scope = context.getStore(); return !scope || scope.generation === generation; }
function assertCurrent() {
  if (!isCurrent()) throw Object.assign(new Error('The database was restored while this work was running; retry the request'), { code: 'DB_RETIRED', status: 503 });
}
function retire() { generation++; }
// Only the authorized restore request is renewed after it completes, so its
// response/session finalization can use the selected DB. Other work stays old.
function refresh() { const scope = context.getStore(); if (scope) scope.generation = generation; }

module.exports = { run, isCurrent, assertCurrent, retire, refresh };
