/**
 * Dongle routes (mounted at /api): the bundled profile list, one profile and its entity catalog, a test
 * connection (Bluetooth or network, with the SSRF guard), and each configured dongle's status. Signed-in only.
 *
 * @module routes/dongle
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const { logger } = require('../modules/logger');
const { getConfig } = require('../modules/database');
const { isAuthenticated } = require('../modules/sessionAuth');
const { isBlockedIp, isValidHostname } = require('../modules/utils');
const entityCatalog = require('../modules/entityCatalog');
const { bundledProfilePath } = require('../modules/bundledProfiles');

const router = express.Router();

router.get('/dongle/profiles', isAuthenticated, (req, res) => {
  try {
    const profilesDir = path.join(__dirname, '..', 'profiles', 'dongles');
    if (!fs.existsSync(profilesDir)) return res.json([]);
    const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
    const profiles = files.map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf8'));
      return { id: f.replace('.json', ''), name: raw.name, transport: raw.transport, requires_serial: raw.requires_serial, default_port: raw.default_port, default_unit_id: raw.default_unit_id, protocol: raw.protocol, capabilities: raw.capabilities, mapping: raw.mapping, connection: raw.connection, read_only: raw.read_only === true, default_poll_interval: raw.default_poll_interval };
    });
    res.json(profiles);
  } catch (err) {
    logger.error('Error listing dongle profiles:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/dongle/profile', isAuthenticated);
router.get('/dongle/profile/:id', (req, res) => {
  try {
    const profilePath = bundledProfilePath('dongles', req.params.id);
    if (!profilePath) return res.status(404).json({ error: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    res.json(profile);
  } catch (err) {
    logger.error('Error loading dongle profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Issue #108 AC-2..6: dongle profile entity catalog — thin wrapper over the
// pure projections in modules/entityCatalog.js (dispatcher mirrors modules/
// dongle.js poll branch keys: luxpower-tcp → namespaced ids, felicity-tcp →
// JSON paths, growatt → field ids, every other transport → bare-hex registers).
// luxpower-geta output is byte-identical to the pre-#108 inline handler
// (snapshot fixture test/entity-catalog.test.js). Pure projection — no metric
// creation, no config writes, no poll side effects. 404/500 shapes unchanged.
router.get('/dongle/profile/:id/entities', (req, res) => {
  try {
    const profilePath = bundledProfilePath('dongles', req.params.id);
    if (!profilePath) return res.status(404).json({ error: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    res.json(entityCatalog.dongleProfileEntities(profile));
  } catch (err) {
    logger.error('Error loading dongle profile entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/dongle/test', isAuthenticated);
router.post('/dongle/test', async (req, res) => {
  const { host, port, serial_number, modbus_unit_id, transport } = req.body;
  if (transport === 'ble-gatt') {
    // Read-only Bluetooth profile (e.g. Phocos Any-Grid): one poll of its blocks.
    const profilePath = bundledProfilePath('dongles', req.body.profile);
    let profile;
    try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (_) { return res.status(400).json({ error: 'Profile not found' }); }
    const { BleGattTransport, identityCheck } = require('./modules/dongle/bleGatt');
    let bt;
    try {
      bt = new BleGattTransport({ ble_address: req.body.ble_address || host }, profile);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    try {
      const data = await bt.poll();
      const blocks = (profile.blocks || []).filter(b => Array.isArray(data[b.id])).length;
      const out = profile.fields.find(f => f.name === 'output_power');
      const w = out ? require('./modules/dongle').getByPathForTest(data, out.path) : undefined;
      return res.json({ success: true, raw: `${blocks}/${profile.blocks.length} blocks read${w !== undefined ? ` — output ${w} W` : ''}`, diagnostics: data.diagnostics, values: data.raw, identity: data.identity, identityCheck: identityCheck(data) });
    } catch (err) {
      logger.warn(`[dongle] Bluetooth test failed for ${bt.address}: ${err.message}`);
      return res.status(502).json({ error: err.message });
    }
  }
  if (transport === 'ble-luxpower') {
    // LuxPower dongle over Bluetooth: same frames as luxpower-tcp, MAC target.
    const { BleLuxpowerTransport } = require('./modules/dongle/bleLuxpower');
    let bt;
    try {
      bt = new BleLuxpowerTransport({
        ble_address: req.body.ble_address || host,
        ble_write_mode: req.body.ble_write_mode, protocol: req.body.protocol,
        dongle_serial: String(req.body.dongle_serial || req.body.serial_number || '').trim(),
        inverter_serial: String(req.body.inverter_serial || req.body.serial_number || '').trim()
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    try {
      // Input registers 0-39: operational state, battery voltage (reg 4, 0.1 V) and SOC (reg 5).
      const data = await bt.readRegisters(0, 40, 0x04);
      return res.json({ success: true, raw: `${data.readUInt16LE(0)} — battery ${(data.readUInt16LE(8) / 10).toFixed(1)} V, ${data.readUInt16LE(10) & 255} %`, diagnostics: bt.diagnostics, ...await require('./modules/dongle/luxpowerModel').identityDiagnostic(bt) });
    } catch (err) {
      logger.warn(`[dongle] Bluetooth test failed for ${bt.address}: ${err.message}`);
      return res.status(502).json({ error: err.message, diagnostics: bt.diagnostics });
    }
  }
  if (transport === 'ble-modbus') {
    // Bluetooth: the target is a MAC address, not a network host — no SSRF surface.
    const { BleModbusTransport } = require('./modules/dongle/bleModbus');
    let bt;
    try {
      bt = new BleModbusTransport({
        ble_address: req.body.ble_address || host,
        ble_write_uuid: req.body.ble_write_uuid,
        ble_notify_uuid: req.body.ble_notify_uuid,
        modbus_unit_id: modbus_unit_id || 1
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    try {
      const data = await bt.readRegisters(0x0100, 1);
      return res.json({ success: true, raw: data.readUInt16BE(0) });
    } catch (err) {
      logger.warn(`[dongle] Bluetooth test failed for ${bt.address}: ${err.message}`);
      return res.status(502).json({ error: err.message });
    }
  }
  if (!host) return res.status(400).json({ error: 'Host required' });

  const rawHost = String(host).trim();
  // #103: RFC1918 literals/resolutions (10/8, 172.16/12, 192.168/16) are now
  // ALLOWED for dongle test dials (intranet inverters). Still blocked: loopback
  // 127/8 + ::1 (+ IPv4-mapped), link-local 169.254/16 incl. metadata + fe80::/10,
  // ULA fc00::/7, and unspecified 0.0.0.0/::. isBlockedIp(ip, true) already blocks
  // loopback/link-local/unspecified (and mapped-loopback via its IPv4 re-check)
  // while ALLOWING RFC1918 — but it also allows ULA when allowPrivate is true,
  // so add an explicit fc00::/7 first-hextet check. Anything non-IP → blocked.
  const isRestrictedTestIp = (ip) => {
    if (isBlockedIp(ip, true)) return true;
    if (net.isIP(ip) !== 6) return false; // v4 RFC1918 + public, or 0 → allow
    const first = String(ip).toLowerCase().split(':')[0];
    if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
    return (parseInt(first, 16) & 0xfe00) === 0xfc00; // ULA fc00::/7
  };

  const ipVersion = net.isIP(rawHost);
  if (ipVersion) {
    if (isRestrictedTestIp(rawHost.toLowerCase())) {
      return res.status(400).json({ error: 'Host is not allowed' });
    }
  } else {
    if (!isValidHostname(rawHost)) {
      return res.status(400).json({ error: 'Invalid host' });
    }
    const lowered = rawHost.toLowerCase();
    if (lowered === 'localhost' || lowered.endsWith('.local')) {
      return res.status(400).json({ error: 'Host is not allowed' });
    }
  }

  const parsedPort = Number.parseInt(port, 10);
  const safePort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null;
  if (port !== undefined && port !== null && port !== '' && safePort === null) {
    return res.status(400).json({ error: 'Invalid port' });
  }
  // SSRF guard (#71/#103): resolve hostnames up front and dial the RESOLVED IP
  // so a DNS-rebinding swap between validation and connect() cannot redirect the
  // TCP dial to a blocked address. Every A/AAAA record must be either public or
  // RFC1918 (intranet inverters are first-class targets); loopback, link-local/
  // metadata, ULA and unspecified stay blocked (isRestrictedTestIp). Mixed
  // public+blocked resolution sets → blocked. Literal IPs are vetted by the
  // same numeric check above (string-prefix block removed — numeric checks now
  // cover 0.0.0.0 and :: too).
  let safeHost = rawHost;
  if (!net.isIP(rawHost)) {
    let addrs;
    try {
      addrs = await dns.promises.lookup(rawHost, { all: true, verbatim: true });
    } catch (_) {
      return res.status(400).json({ error: 'Invalid host' });
    }
    if (!addrs || addrs.length === 0) return res.status(400).json({ error: 'Invalid host' });
    for (const a of addrs) {
      if (isRestrictedTestIp(a.address)) {
        return res.status(400).json({ error: 'Host is not allowed' });
      }
    }
    safeHost = addrs[0].address;
  }

  try {
    let transportObj;
    if (transport === 'felicity-tcp') {
      transportObj = new (require('./modules/dongle/felicityTcp').FelicityTcpTransport)({ host: safeHost, port: safePort || 53970 });
      const data = await transportObj.poll();
      const count = data.realtime ? Object.keys(data.realtime).length : 0;
      res.json({ success: true, raw: `JSON OK — ${count} realtime keys` });
      return;
    }
    if (transport === 'luxpower-tcp') {
      // #103/AC18: stranded serial_number is usable as the dongle serial too.
      const dongleSerial = String(req.body.dongle_serial || req.body.serial_number || '').trim();
      const inverterSerial = String(req.body.inverter_serial || req.body.serial_number || '').trim();
      if (!dongleSerial || !inverterSerial) {
        return res.status(400).json({ error: 'Dongle serial and inverter serial are required for luxpower-tcp' });
      }
      const LuxpowerTcpTransport = require('./modules/dongle/luxpowerTcp').LuxpowerTcpTransport;
      try {
        transportObj = new LuxpowerTcpTransport({
          host: safeHost,
          port: safePort || 8000,
          dongle_serial: dongleSerial,
          inverter_serial: inverterSerial,
          timeout_ms: 5000, tls_policy: req.body.tls_policy, protocol: req.body.protocol
        });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      try {
        // Real read cycle: input register 0x0000 (operational state); values
        // are little-endian words on the wire (see luxpower-geta profile).
        const data = await transportObj.readRegisters(0, 1, 0x04);
        res.json({ success: true, raw: data.readUInt16LE(0), diagnostics: transportObj.diagnostics, ...await require('./modules/dongle/luxpowerModel').identityDiagnostic(transportObj) });
      } catch (err) {
        res.status(502).json({ error: err.message, diagnostics: transportObj.diagnostics });
      } finally {
        transportObj.stop();
      }
      return;
    }
    if (transport === 'solarman-v5') {
      transportObj = new (require('./modules/dongle/solarmanV5').SolarmanV5Transport)({ host: safeHost, port: safePort || 8899, serial_number, modbus_unit_id: modbus_unit_id || 1 });
    } else {
      transportObj = new (require('./modules/dongle/modbusTcp').ModbusTcpTransport)({ host: safeHost, port: safePort || 502, modbus_unit_id: modbus_unit_id || 1 });
    }
    const data = await transportObj.readRegisters(0x0100, 1);
    res.json({ success: true, raw: data.readUInt16BE(0) });
  } catch (err) {
    logger.warn(`[dongle] test connection failed to ${safeHost}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/dongle/status', isAuthenticated);
router.get('/dongle/status', (req, res) => {
  try {
    const raw = getConfig('dongle_config');
    if (!raw || raw === '[]') return res.json([]);
    const config = JSON.parse(raw);
    const result = config.map(inst => ({
      name: inst.name,
      enabled: inst.enabled,
      transport: inst.transport,
      lastSeen: inst.lastSeen || null,
      consecutiveFails: inst.consecutiveFails || 0
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
