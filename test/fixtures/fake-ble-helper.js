#!/usr/bin/env node
/**
 * Stand-in for modules/ble/ble_helper.py used by test/ble-helper.test.js.
 * Speaks the same JSON-lines protocol. Commands:
 *   echo {..}   -> result = args (after args.delayMs)
 *   fail        -> error with code args.code
 *   hang        -> never answers
 *   die         -> exits with code 3
 */
'use strict';
const readline = require('readline');

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
if (process.env.FAKE_BLE_NO_READY !== '1') emit({ event: 'ready', pid: process.pid });
process.stderr.write('INFO fake helper started\n');

readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  const args = req.args || {};
  switch (req.cmd) {
    case 'echo':
      setTimeout(() => emit({ id: req.id, ok: true, result: { ...args, pid: process.pid, at: Date.now() } }), args.delayMs || 0);
      break;
    case 'fail':
      emit({ id: req.id, ok: false, error: 'nope', code: args.code || 'ble_error' });
      break;
    case 'hang':
      break;
    case 'die':
      process.exit(3);
      break;
    default:
      emit({ id: req.id, ok: false, error: 'unknown', code: 'bad_request' });
  }
});
