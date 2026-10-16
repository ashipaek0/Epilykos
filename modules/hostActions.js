/**
 * Client for the EpilykosOS host interface (epilykos-hostd, contract
 * C-HOST-001): restart, shut down, open Bluetooth Wi-Fi setup, and the SSH
 * maintenance login. On EpilykosOS the socket is bind-mounted into the
 * container and EPILYKOS_HOST_SOCKET names it; anywhere else (Docker
 * Compose, development) it is absent and the features are hidden.
 *
 * One JSON request line, one JSON reply line per connection.
 *
 * @module modules/hostActions
 */
'use strict';
const fs = require('fs');
const net = require('net');

const TIMEOUT_MS = 15000;
const MAX_REPLY = 64 * 1024;

function socketPath() {
  return process.env.EPILYKOS_HOST_SOCKET || '';
}

/** True when this instance runs on EpilykosOS with its host interface. */
function available() {
  const p = socketPath();
  if (!p) return false;
  try {
    return fs.statSync(p).isSocket();
  } catch (_) {
    return false;
  }
}

/**
 * Send one action to the host. Resolves with the reply object; rejects
 * with an Error whose `status` is 503 when the host can't be reached.
 */
function call(action, params = {}, { socket = socketPath(), timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket) {
      const err = new Error('Not running on EpilykosOS');
      err.status = 404;
      return reject(err);
    }
    let buf = '';
    let done = false;
    const conn = net.createConnection(socket);
    const finish = (err, value) => {
      if (done) return;
      done = true;
      conn.destroy();
      if (err) reject(err); else resolve(value);
    };
    conn.setTimeout(timeoutMs, () => {
      const err = new Error('The appliance did not answer in time');
      err.status = 504;
      finish(err);
    });
    conn.on('error', e => {
      const err = new Error('The appliance\'s system service is not reachable');
      err.status = 503;
      err.cause = e;
      finish(err);
    });
    conn.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_REPLY) {
        const err = new Error('Reply from the appliance was too large');
        err.status = 502;
        return finish(err);
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        finish(null, JSON.parse(buf.slice(0, nl)));
      } catch (_) {
        const err = new Error('Unreadable reply from the appliance');
        err.status = 502;
        finish(err);
      }
    });
    conn.on('end', () => {
      if (!done) {
        const err = new Error('The appliance closed the connection');
        err.status = 502;
        finish(err);
      }
    });
    conn.write(JSON.stringify(Object.assign({}, params, { action })) + '\n');
  });
}

module.exports = { available, call, socketPath };
