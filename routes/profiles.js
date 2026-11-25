/**
 * Modbus and RS232 routes (mounted at /api): the bundled profile lists, one profile and its entity catalog, the
 * serial ports, and the test connections. Signed-in only. The entity catalogs are pure projections of a parsed profile.
 *
 * @module routes/profiles
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { logger } = require('../modules/logger');
const { isAuthenticated } = require('../modules/sessionAuth');
const entityCatalog = require('../modules/entityCatalog');
const { bundledProfilePath } = require('../modules/bundledProfiles');
const { testModbusConnection, availableProfiles } = require('../modules/modbus');
const { testRs232Connection, getAvailablePorts, availableProfiles: rs232Profiles } = require('../modules/rs232');

const router = express.Router();

function modbusProfileEntities(profile) {
  // AC-7: one item per registers[], id = String(r.address) — the exact handle
  // modules/modbus.js addrToMetric[String(address)] consumes (poll filter L132,
  // metric name L167). name = r.metric, the implicit default metric name.
  const registers = profile && Array.isArray(profile.registers) ? profile.registers : [];
  const entities = [];
  for (const r of registers) {
    if (r.address === undefined || r.address === null || String(r.address).trim() === '') continue;
    if (r.metric === undefined) continue; // not decode-reachable without a metric
    entities.push(entityCatalog.catEntity({
      id: String(r.address),
      name: r.metric,
      label: r.label,
      unit: r.unit,
      scale: r.scale,
      type: r.type,
      kind: 'register'
    }));
  }
  entities.sort((a, b) => (Number(a.id) - Number(b.id)) || String(a.id).localeCompare(String(b.id)));
  return entities;
}

function rs232HexNum(reg) {
  const s = String(reg).trim();
  return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

function rs232ProfileEntities(profile) {
  // AC-8: per-family projection over an ALIAS-RESOLVED profile (the route feeds
  // the in-memory profile, which loadRs232Profiles()/resolveAliases() already
  // merged — infinisolar yields voltronic's commands). Decode-key contract
  // mirrors modules/rs232.js exactly:
  //  - query/ascii family:  decodeAsciiResponse L261 → `${cmd.name}:${idx}`
  //  - modbus-rtu family:   pollModbusRtuDevice L496 → m.register (bare hex)
  //  - vedirect family:     decodeVedirectFrame L293 → field.label
  //  - solax/binary family: solax-decoder L120 → `${dataCmd.name}:${offset}`
  if (!profile || typeof profile !== 'object') return [];
  const protocol = profile.protocol ? String(profile.protocol).toLowerCase() : '';
  const entities = [];

  if (protocol === 'modbus-rtu') {
    for (const m of (Array.isArray(profile.metrics) ? profile.metrics : [])) {
      if (m.register === undefined || m.register === null || String(m.register).trim() === '') continue;
      entities.push(entityCatalog.catEntity({
        id: m.register,
        name: m.name,
        label: m.label,
        unit: m.unit,
        scale: m.scale,
        type: m.type,
        kind: 'register'
      }));
    }
    entities.sort((a, b) => rs232HexNum(a.id) - rs232HexNum(b.id));
    return entities;
  }

  if (protocol === 'vedirect-streaming') {
    for (const f of (Array.isArray(profile.fields) ? profile.fields : [])) {
      if (f.label === undefined || f.label === null) continue;
      const metricName = f.metric_prefix ? `${f.metric_prefix}_${f.metric}` : f.metric;
      entities.push(entityCatalog.catEntity({
        id: f.label,
        name: metricName,
        label: f.label,
        unit: f.unit,
        scale: f.scale,
        type: f.type,
        kind: 'vedirect'
      }));
    }
    entities.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return entities;
  }

  const commands = Array.isArray(profile.commands) ? profile.commands : [];

  if (profile.decoder || protocol === 'solax-aa55') {
    // Custom binary decoder (SolaX AA55): only the DATA command (function > 5)
    // carries metric payload — register/serial handshakes decode to nothing
    // (solax-decoder L77-79). Fall back to the LAST command when none exceeds 5.
    const funcVal = (cmd) => {
      if (!cmd || cmd.function === undefined) return NaN;
      const v = cmd.function;
      if (typeof v === 'number') return v;
      const s = String(v).trim();
      return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    };
    const dataCmd = commands.find(c => Number.isFinite(funcVal(c)) && funcVal(c) > 5) || commands[commands.length - 1] || null;
    if (dataCmd) {
      for (const f of (Array.isArray(profile.fields) ? profile.fields : [])) {
        if (f.offset === undefined || f.offset === null) continue;
        entities.push(entityCatalog.catEntity({
          id: `${dataCmd.name}:${f.offset}`,
          name: f.metric,
          label: f.label,
          unit: f.unit,
          scale: f.scale,
          type: f.type,
          kind: 'binary'
        }));
      }
    }
    return entities;
  }

  // Default query/response ASCII family (voltronic-qpigs, infinisolar alias,
  // and any future ascii query profile) — fields nested per command, keyed by
  // index. Deterministic: command order preserved, then field index order.
  for (const cmd of commands) {
    if (!cmd || cmd.name === undefined) continue;
    for (const f of (Array.isArray(cmd.fields) ? cmd.fields : [])) {
      if (f.index === undefined || f.index === null) continue;
      entities.push(entityCatalog.catEntity({
        id: `${cmd.name}:${f.index}`,
        name: f.metric,
        label: f.label,
        unit: f.unit,
        scale: f.scale,
        type: f.type,
        kind: 'ascii'
      }));
    }
  }
  return entities;
}

router.use('/modbus/profiles', isAuthenticated);
router.get('/modbus/profiles', (req, res) => {
  res.json(availableProfiles.map(p => ({ id: p.id, name: p.name, connection: p.connection })));
});

router.use('/modbus/profile', isAuthenticated);
router.get('/modbus/profile/:id', (req, res) => {
  const { getProfileById } = require('../modules/modbus');
  const profile = getProfileById(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

// AC-7 (#108): entity catalog for one modbus profile — one item per
// registers[], id = String(address) (decimal), the exact handle the module
// reverse-lookup consumes (modules/modbus.js L132/L167); name = r.metric (the
// implicit default). Same auth as the profile GET above; pure projection, no
// metric creation, no writes.
router.get('/modbus/profile/:id/entities', (req, res) => {
  const { getProfileById } = require('../modules/modbus');
  const profile = getProfileById(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  try {
    res.json(modbusProfileEntities(profile));
  } catch (err) {
    logger.error('Error projecting modbus profile entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/test-modbus', isAuthenticated);
router.post('/test-modbus', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (device.transport === 'tcp' && !device.host) return res.status(400).json({ error: 'Host required for TCP' });
  if (device.transport === 'serial' && !device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  try {
    const result = await testModbusConnection(device);
    res.json(result);
  } catch (err) {
    logger.error('Modbus test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RS232 API Endpoints ────────────────────────────────────────────────
router.use('/rs232/profiles', isAuthenticated);
router.get('/rs232/profiles', (req, res) => {
  // placeholder: unverified skeleton register map — pickers hide it unless already selected
  res.json(rs232Profiles.map(p => ({ id: p.id, name: p.name, protocol: p.protocol, description: p.description || '', placeholder: p.placeholder === true, defaults: p.defaults || null })));
});

router.use('/rs232/profile', isAuthenticated);
router.get('/rs232/profile/:id', (req, res) => {
  const profile = rs232Profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Resolve profile_file alias and return full profile with fields/commands
  const profilePath = bundledProfilePath('rs232', profile.id);
  if (!profilePath) return res.status(404).json({ error: 'Profile not found' });
  try {
    const fullProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    // Issue #108 AC-9: serve the ALIAS-MERGED profile — resolve profile_file
    // exactly like modules/rs232.js resolveAliases() (L117-130), so legacy
    // "📥 Load Profile Fields" renders commands/fields for alias profiles
    // (infinisolar → voltronic-qpigs) instead of the raw file's empty arrays.
    if (fullProfile.profile_file) {
      const targetId = String(fullProfile.profile_file).replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
      const targetPath = path.join(__dirname, '..', 'profiles', 'rs232', `${targetId}.json`);
      if (fs.existsSync(targetPath)) {
        const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        fullProfile.commands = target.commands !== undefined ? target.commands : (fullProfile.commands || []);
        fullProfile.fields = target.fields !== undefined ? target.fields : (fullProfile.fields || []);
        fullProfile.frame_format = target.frame_format !== undefined ? target.frame_format : fullProfile.frame_format;
        fullProfile.call_order = target.call_order !== undefined ? target.call_order : fullProfile.call_order;
        if (!fullProfile.decoder && target.decoder !== undefined) fullProfile.decoder = target.decoder;
      }
    }
    res.json(fullProfile);
  } catch (err) {
    logger.error('Error loading rs232 profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AC-8 (#108): entity catalog for one rs232 profile — projects the IN-MEMORY
// profile, which loadRs232Profiles()/resolveAliases() already alias-merged, so
// infinisolar yields voltronic's commands. id is the exact decode handle per
// protocol family (see rs232ProfileEntities); pure projection, no writes.
router.get('/rs232/profile/:id/entities', (req, res) => {
  const profile = rs232Profiles.find(p => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  try {
    res.json(rs232ProfileEntities(profile));
  } catch (err) {
    logger.error('Error projecting rs232 profile entities:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/rs232/ports', isAuthenticated);
router.get('/rs232/ports', async (req, res) => {
  try {
    const ports = await getAvailablePorts();
    res.json(Array.isArray(ports) ? ports : []);
  } catch (err) {
    logger.error('RS232 port scan error:', err);
    res.json([]);
  }
});

router.use('/test-rs232', isAuthenticated);
router.post('/test-rs232', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (!device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  if (!device.profile) return res.status(400).json({ error: 'Profile required' });
  try {
    const result = await testRs232Connection(device);
    res.json(result);
  } catch (err) {
    logger.error('RS232 test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.modbusProfileEntities = modbusProfileEntities;
module.exports.rs232ProfileEntities = rs232ProfileEntities;
