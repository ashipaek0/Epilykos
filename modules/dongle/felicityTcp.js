/**
 * Felicity TCP/JSON Transport — raw TCP client for Felicity inverters that expose
 * a proprietary JSON API on port 53970 (NOT Modbus).
 *
 * Sends 3 ASCII commands per poll cycle and parses JSON responses. Handles
 * PV layout auto-detection (standard vs aggregated firmware) and settings
 * pack merging.
 *
 * @module dongle/felicityTcp
 */
const net = require('net');

class FelicityTcpTransport {
  constructor(instance) {
    this.host = instance.host;
    this.port = instance.port || 53970;
  }

  /**
   * Run a full poll cycle — send all 3 commands and return parsed data.
   * @returns {Promise<{realtime: object, basic: object, settings: object}>}
   */
  async poll() {
    const realtime = await this._sendCommand('wifilocalMonitor:get dev real infor');
    const basic = await this._sendCommand('wifilocalMonitor:get dev basice infor');
    const settingsPacks = await this._sendCommandMulti('wifilocalMonitor:get dev set infor');

    this._normalizePv(realtime);

    const settings = {};
    for (const pack of settingsPacks) {
      Object.assign(settings, pack);
    }

    return { realtime, basic, settings };
  }

  /** Send a command and parse a single JSON response */
  _sendCommand(cmd) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = '';
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 8000);

      socket.connect(this.port, this.host, () => {
        socket.write(cmd + '\n');
      });

      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        try {
          const obj = JSON.parse(buffer);
          clearTimeout(timeout);
          socket.destroy();
          resolve(obj);
        } catch (e) { /* incomplete, wait for more data */ }
      });

      socket.on('error', err => { clearTimeout(timeout); reject(err); });
    });
  }

  /** Send a command that may return multiple concatenated JSON objects */
  _sendCommandMulti(cmd) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = '';
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 8000);

      socket.connect(this.port, this.host, () => {
        socket.write(cmd + '\n');
      });

      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const objs = this._extractObjects(buffer);
        if (objs.length > 0) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(objs);
        }
      });

      socket.on('error', err => { clearTimeout(timeout); reject(err); });
    });
  }

  /** Extract one or more JSON objects from a buffer that may be concatenated */
  _extractObjects(str) {
    const objs = [];
    let remaining = str.trim();
    let safety = 0;
    while (remaining.length > 0 && safety++ < 20) {
      try {
        objs.push(JSON.parse(remaining));
        break;
      } catch (e) {
        const endIdx = remaining.indexOf('}');
        if (endIdx === -1) break;
        try {
          objs.push(JSON.parse(remaining.substring(0, endIdx + 1)));
          remaining = remaining.substring(endIdx + 1).trim();
        } catch {
          break;
        }
      }
    }
    return objs;
  }

  /**
   * Detect PV data layout and normalize to standard format.
   * Some firmware reports aggregated PV (single MPPT) where voltage/current/power
   * are spread across PV[0][0], PV[1][0], PV[2][0] instead of PV[0][0-2].
   */
  _normalizePv(data) {
    const pv = data.PV;
    if (!pv || !Array.isArray(pv)) return;

    if (pv[0] && pv[0][0] > 500 && pv[0][1] === 0 && pv[0][2] === 0) {
      const voltage = pv[0][0] || 0;
      const current = (pv[1] && pv[1][0]) || 0;
      const power   = (pv[2] && pv[2][0]) || 0;
      const total   = (pv[3] && pv[3][0]) || 0;

      pv[0] = [voltage, current, power];
      pv[1] = [0, 0, 0];
      pv[2] = [0, 0, 0];
      pv[3] = [total];
    }
  }
}

module.exports = { FelicityTcpTransport };
