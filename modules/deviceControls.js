/**
 * Device controls: the safety rules for changing inverter and battery
 * settings, in one place every write path goes through.
 *
 * - Changing device settings is off until it is turned on (config
 *   device_writes_enabled). Raw register writes (any address, outside a
 *   profile's list of settings) need a second switch (device_writes_expert).
 * - A signed-in session must also unlock changes with the password again;
 *   the unlock lasts UNLOCK_MS and ends at sign-out.
 * - A listed setting is read first. The change is refused when the current
 *   reading is outside the setting's range (the register may not mean what
 *   the profile says on this device), when it changed since the page showed
 *   it, or when the new value is out of range or off-step. After the write
 *   the setting is read back; a different value is reported as a failure.
 * - Every attempt is kept in the change log (device_write_log), refused ones
 *   included.
 *
 * @module deviceControls
 */
const { getConfig, setConfig, getDb } = require('./database');
const { logger } = require('./logger');

const UNLOCK_MS = 5 * 60 * 1000;
const LOG_KEEP = 2000;

// ── Switches ──────────────────────────────────────────────────────────────

function writesEnabled() { return getConfig('device_writes_enabled') === 'true'; }
function expertEnabled() { return writesEnabled() && getConfig('device_writes_expert') === 'true'; }
function setSwitches({ enabled, expert }) {
  if (enabled !== undefined) setConfig('device_writes_enabled', enabled ? 'true' : 'false');
  if (expert !== undefined) setConfig('device_writes_expert', expert ? 'true' : 'false');
  if (!writesEnabled()) setConfig('device_writes_expert', 'false');
}

/** Refusal for a write when the switches don't allow it, else null. */
function writeRefusal({ raw = false } = {}) {
  if (!writesEnabled()) return 'Changing device settings is turned off. Turn it on on the Controls page.';
  if (raw && !expertEnabled()) return 'Register writes outside a device\'s list of settings are turned off. Turn on expert register writes on the Controls page.';
  return null;
}

// ── Unlock (password again, for a few minutes) ───────────────────────────

function unlockedUntil(req) {
  const t = req && req.session && req.session.controlsUnlockedUntil;
  return typeof t === 'number' && t > Date.now() ? t : 0;
}
function unlock(req) { req.session.controlsUnlockedUntil = Date.now() + UNLOCK_MS; return req.session.controlsUnlockedUntil; }
function lock(req) { if (req.session) delete req.session.controlsUnlockedUntil; }
/** Express middleware: 423 unless this session unlocked changes recently (refusals are logged). */
function requireUnlocked(req, res, next) {
  if (unlockedUntil(req)) return next();
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  logAttempt({ source: req.originalUrl === '/api/action' ? 'action:' + String(b.source || '') : 'controls' + (req.path || ''),
    device: b.device, target: b.entity || b.setting || b.register, label: b.action, newValue: b.value !== undefined ? b.value : b.params && b.params.value,
    outcome: 'refused', detail: 'Changes are locked' }, req);
  res.status(423).json({ success: false, error: 'Changes are locked. Unlock them on the Controls page with your password.', locked: true });
}

// ── Change log ────────────────────────────────────────────────────────────

let tableReady = false;
function table() {
  const db = getDb();
  if (!tableReady) {
    db.exec(`CREATE TABLE IF NOT EXISTS device_write_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      device TEXT,
      target TEXT,
      label TEXT,
      old_value TEXT,
      new_value TEXT,
      outcome TEXT NOT NULL,
      detail TEXT,
      ip TEXT
    )`);
    tableReady = true;
  }
  return db;
}
const str = v => (v === undefined || v === null ? null : String(v).slice(0, 200));

/** Record one attempt. outcome: 'done' | 'refused' | 'failed' | 'unverified'. */
function logAttempt(entry, req) {
  try {
    const db = table();
    db.prepare(`INSERT INTO device_write_log (ts, source, device, target, label, old_value, new_value, outcome, detail, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Date.now(), str(entry.source) || 'unknown', str(entry.device), str(entry.target), str(entry.label),
      str(entry.oldValue), str(entry.newValue), entry.outcome, str(entry.detail), str(req && (req.ip || (req.socket && req.socket.remoteAddress))));
    db.prepare('DELETE FROM device_write_log WHERE id <= (SELECT MAX(id) FROM device_write_log) - ?').run(LOG_KEEP);
  } catch (e) {
    logger.error('Could not record a device change:', e.message);
  }
}

function recentLog(limit = 100) {
  const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
  return table().prepare('SELECT ts, source, device, target, label, old_value, new_value, outcome, detail FROM device_write_log ORDER BY id DESC LIMIT ?').all(n);
}

// ── Settings from device profiles ─────────────────────────────────────────

function dongleDevices() {
  try { return JSON.parse(getConfig('dongle_config') || '[]').filter(d => d && d.enabled); } catch { return []; }
}

/** A profile's listed settings, in the shape the Controls page shows. */
function settingsOf(profile) {
  if (profile && profile.protocol === 'ble-gatt' && Array.isArray(profile.settings)) return profile.settings.map(w => ({ type: w.type === 'boolean' ? 'switch' : w.type === 'enum' ? 'select' : 'number', name: w.id, label: w.label || w.id, description: w.reason || '', unit: w.unit || '', min: w.min, max: w.max, step: w.step, allowed: w.allowed, writable: false, blockedReason: 'Read the device first to verify its model and setting capability' }));
  if (!profile || !profile.capabilities || profile.capabilities.write !== true) return [];
  return (Array.isArray(profile.writable_registers) ? profile.writable_registers : [])
    .filter(w => w && w.name && w.register && (w.kind || 'value') === 'value')
    .map(w => ({
      type: 'number', name: w.name, label: w.label || w.name, description: w.description || '', unit: w.unit || '',
      register: w.register, register_type: w.register_type || 'holding',
      min: Number(w.min), max: Number(w.max), step: Number(w.step) > 0 ? Number(w.step) : 1, scale: Number(w.scale) > 0 ? Number(w.scale) : 1,
      below: w.below || null, above: w.above || null
    }))
    .filter(s => Number.isFinite(s.min) && Number.isFinite(s.max) && s.min <= s.max);
}

/** Devices that have settings to change (and the switches' state). */
function listDevices() {
  const dongle = require('./dongle');
  const out = [];
  for (const d of dongleDevices()) {
    const profile = dongle.getProfileById(d.profile);
    const settings = settingsOf(profile);
    out.push({ name: d.name, kind: 'dongle', profile: d.profile || '', profileName: (profile && profile.name) || d.profile || '',
      transport: d.transport || (profile && profile.transport) || '', settings,
      rawWrites: !!profile && !['growatt', 'felicity-tcp', 'ble-gatt'].includes(profile.protocol || d.transport),
      rawReads: !!profile && profile.protocol === 'luxpower-tcp',
      note: profile && profile.protocol === 'ble-gatt' ? 'Settings start blocked; read the device to verify its model and current write capability.' : (settings.length ? '' : 'no settings list for this profile yet') });
  }
  for (const d of bmsDevices()) {
    const kind = bmsKindOf(d);
    out.push({ name: d.name, kind: 'bms', address: d.address, profile: d.bms_type || '', transport: 'bluetooth',
      profileName: kind === 'jbd' ? 'JBD BMS' : kind === 'jk' ? 'JK BMS' : (d.bms_type || 'Bluetooth BMS'),
      settings: kind ? BMS_SETTINGS : [], rawWrites: false, rawReads: false,
      note: kind ? '' : (process.env.BMS_BRIDGE_URL ? 'not available through the legacy BMS bridge' : (d.bms_type ? 'switching is available for JBD and JK packs only' : 'its settings show once it has been read: set its type, or wait for the next poll')) });
  }
  let modbus = [];
  try { modbus = JSON.parse(getConfig('modbus_devices') || '[]').filter(d => d && d.enabled); } catch { modbus = []; }
  for (const d of modbus) out.push({ name: d.name, kind: 'modbus', profile: d.profile || '', profileName: d.profile || 'Modbus', transport: 'modbus', settings: [], rawWrites: true, rawReads: false });
  return out;
}

// ── Bluetooth BMS (JBD, JK): charging and discharging on/off ──────────────

const BMS_SETTINGS = [
  { type: 'switch', name: 'charging', label: 'Charging', description: 'Whether the pack accepts charge (its charge switch).', field: 'chrg_mosfet', which: 'charge' },
  { type: 'switch', name: 'discharging', label: 'Discharging', description: 'Whether the pack supplies power. Off cuts everything this battery powers.', field: 'dischrg_mosfet', which: 'discharge' }
];
const BMS_TYPE_KIND = { jbd_bms: 'jbd', jikong_bms: 'jk' };

function bmsDevices() {
  try { return JSON.parse(getConfig('bms_devices') || '[]').filter(d => d && d.enabled && d.address && d.name); } catch { return []; }
}
/** 'jbd' / 'jk' when the pack can be switched from here, else ''. */
function bmsKindOf(d) {
  if (process.env.BMS_BRIDGE_URL) return '';
  if (d.bms_type) return BMS_TYPE_KIND[d.bms_type] || '';
  return BMS_TYPE_KIND[require('./ble').bmsKind(d.address)] || '';
}

/** Both switch states now: { charging: 'on'|'off', discharging: 'on'|'off' }. */
async function readBmsSwitches(dev) {
  let data;
  try { data = await require('./ble').readBms(dev.address, { bmsType: dev.profile }); }
  catch (e) { return { error: e.message }; }
  const out = {};
  for (const s of BMS_SETTINGS) {
    const v = data && data[s.field];
    if (v !== 0 && v !== 1) return { error: `The pack did not report its ${s.label.toLowerCase()} state` };
    out[s.name] = v === 1 ? 'on' : 'off';
  }
  return out;
}

async function changeBmsSwitch(p, dev, setting, req) {
  const base = { source: 'controls', device: dev.name, target: setting.name, label: setting.label, newValue: p.value };
  const refuse = (detail, extra = {}) => { logAttempt({ ...base, ...extra, outcome: 'refused', detail }, req); return { success: false, error: detail, ...extra }; };
  const off = writeRefusal();
  if (off) return refuse(off);
  if (p.value !== 'on' && p.value !== 'off') return refuse('Choose on or off');
  const now = await readBmsSwitches(dev);
  if (now.error) return refuse(`Could not read the pack first: ${now.error}`);
  base.oldValue = now[setting.name];
  if (p.expected !== undefined && p.expected !== null && p.expected !== '' && p.expected !== now[setting.name]) {
    return refuse(`It changed since you looked: it is now ${now[setting.name]}. Check and try again.`, { current: now[setting.name] });
  }
  if (now[setting.name] === p.value) {
    logAttempt({ ...base, outcome: 'done', detail: 'Already set; nothing sent' }, req);
    return { success: true, value: p.value, unchanged: true };
  }
  let sendError = null;
  try {
    await require('./ble').bmsSwitch(dev.address, { bmsType: dev.profile, which: setting.which, on: p.value === 'on',
      chargeOn: now.charging === 'on', dischargeOn: now.discharging === 'on' });
  } catch (e) {
    // The command may have gone out before the error (a lost reply, a time-out
    // while the pack settles), so read the pack back before calling it failed.
    sendError = e.message;
  }
  const back = await readBmsSwitches(dev);
  if (back.error) {
    logAttempt({ ...base, outcome: 'unverified', detail: sendError ? `${sendError}; reading the pack back also failed: ${back.error}` : `Sent, but reading it back failed: ${back.error}` }, req);
    return { success: false, written: true, error: sendError
      ? `The pack didn't answer (${sendError}), and reading it back failed, so the change may or may not have happened. Read it again to check.`
      : `The change was sent, but reading the pack back failed (${back.error}). Read it again to check.` };
  }
  if (sendError && back[setting.name] !== p.value) {
    logAttempt({ ...base, outcome: 'failed', detail: sendError }, req);
    return { success: false, error: sendError, value: back[setting.name] };
  }
  const other = BMS_SETTINGS.find(s => s !== setting);
  if (back[other.name] !== now[other.name]) {
    logAttempt({ ...base, outcome: 'failed', detail: `${other.label} also changed, to ${back[other.name]}` }, req);
    return { success: false, written: true, value: back[setting.name], error: `${other.label} changed too (now ${back[other.name]}). Check the pack.` };
  }
  if (back[setting.name] !== p.value) {
    const why = p.value === 'on' ? ' The pack may be protecting itself (for example a cell is too high, too low or too hot), or it did not accept the command.' : ' It did not accept the command.';
    logAttempt({ ...base, outcome: 'failed', detail: `Read back ${back[setting.name]}` }, req);
    return { success: false, written: true, value: back[setting.name], error: `The pack still reports ${setting.label.toLowerCase()} ${back[setting.name]}.${why}` };
  }
  logAttempt({ ...base, outcome: 'done', detail: 'Read back and matched' }, req);
  return { success: true, value: back[setting.name] };
}

/**
 * The listed setting a dongle register belongs to, if any ('holding:0x00A0',
 * '0x00A0' or 160). Switch and selector cards address settings by register.
 */
function listedSettingFor(deviceName, register) {
  const dev = listDevices().find(d => d.kind === 'dongle' && d.name === deviceName);
  if (!dev || !dev.settings.length) return null;
  const m = String(register == null ? '' : register).trim().match(/^(?:(input|holding):)?(0x[0-9a-f]+|\d+)$/i);
  if (!m) return null;
  const addr = m[2].toLowerCase().startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
  return dev.settings.find(s => s.register && parseInt(s.register, 16) === addr && (!m[1] || (s.register_type || 'holding') === m[1].toLowerCase())) || null;
}

function findSetting(deviceName, settingName) {
  const dev = listDevices().find(d => (d.kind === 'dongle' || d.kind === 'bms') && d.name === deviceName);
  if (!dev) return { error: 'Device not found or turned off' };
  const setting = dev.settings.find(s => s.name === settingName);
  if (!setting) return { error: 'That setting is not in this device\'s list' };
  return { dev, setting };
}

const decimals = step => { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; };
/** Raw register word → value in the setting's units. */
function toValue(setting, raw) { return Number((raw * setting.scale).toFixed(decimals(setting.scale * setting.step) + 2)); }
/** Value in units → raw register word, or an error. */
function toRaw(setting, value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(n)) return { error: 'Enter a number' };
  if (n < setting.min || n > setting.max) return { error: `Must be between ${setting.min} and ${setting.max}${setting.unit ? ' ' + setting.unit : ''}` };
  const steps = (n - setting.min) / setting.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return { error: `Must be in steps of ${setting.step}${setting.unit ? ' ' + setting.unit : ''}` };
  const raw = Math.round(n / setting.scale);
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xFFFF) return { error: 'Out of the register\'s range' };
  return { raw };
}

/** Read one listed setting now. */
async function readSetting(deviceName, settingName) {
  const found = findSetting(deviceName, settingName);
  if (found.error) return found;
  const { dev, setting } = found;
  if (dev.kind === 'bms') {
    const r = await readBmsSwitches(dev);
    return r.error ? r : { value: r[setting.name], inRange: true };
  }
  if (dev.transport === 'ble-gatt' || dev.profile === 'phocos-anygrid-ble') {
    const result = await require('./dongle').phocosSettings(dev.name);
    if (result.error) return result;
    const capability = (result.capabilities || []).find(c => c.id === setting.name) || null;
    const rawMetadata = result.values && result.values[setting.name] || null;
    const value = rawMetadata && rawMetadata.value;
    const type = capability && capability.type;
    const min = capability && capability.min;
    const max = capability && capability.max;
    const allowed = capability && capability.allowed;
    const step = capability && capability.step;
    const valuePresent = !!rawMetadata && value !== undefined;
    const inRange = valuePresent && (type === 'bool' || type === 'boolean' ? typeof value === 'boolean' : type === 'enum' ? Array.isArray(allowed) && allowed.includes(value) : Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max) && (!(step > 0) || Math.abs((value - (min || 0)) / step - Math.round((value - (min || 0)) / step)) <= 1e-6));
    return { value, current: value, inRange, raw: result.raw, rawMetadata, capability, writable: !!(capability && capability.writable), blockedReason: capability && capability.blockedReason || (!valuePresent ? 'Setting is not available in the current device read' : null), model: result.model };
  }
  const raw = await require('./dongle').readDongleRegister(dev.name, setting.register, setting.register_type);
  if (raw.error) return raw;
  const value = toValue(setting, raw.value);
  return { value, raw: raw.value, inRange: value >= setting.min && value <= setting.max };
}

/**
 * Change one listed setting: check, write, read back. Every outcome is logged.
 * @param {object} p - { device, setting, value, expected } (expected = the value the page showed)
 */
async function changeSetting(p, req) {
  const base = { source: 'controls', device: p.device, target: p.setting, newValue: p.value };
  const refuse = (detail, extra = {}) => { logAttempt({ ...base, ...extra, outcome: 'refused', detail }, req); return { success: false, error: detail, ...extra }; };
  const switchOff = writeRefusal();
  if (switchOff) return refuse(switchOff);
  const found = findSetting(p.device, p.setting);
  if (found.error) return refuse(found.error);
  const { dev, setting } = found;
  if (dev.kind === 'bms') return changeBmsSwitch(p, dev, setting, req);
  base.label = setting.label;
  if (dev.transport === 'ble-gatt' || dev.profile === 'phocos-anygrid-ble') {
    if (p.expected === undefined || p.expected === null || p.expected === '') return refuse('Read the current value and provide expected before changing this setting');
    const now = await readSetting(dev.name, setting.name);
    if (now.error) return refuse(`Could not read the current value first: ${now.error}`);
    base.oldValue = now.value;
    if (!now.capability || !now.capability.writable) return refuse(now.blockedReason || 'This setting is not writable for the verified device model');
    if (!now.inRange) return refuse('The current setting value is outside its supported range');
    if (typeof p.expected !== typeof now.value || p.expected !== now.value) return refuse(`It changed since you looked: it is now ${now.value}. Check and try again.`, { current: now.value });
    const capability = now.capability;
    const type = capability && capability.type;
    const valid = type === 'bool' || type === 'boolean' ? typeof p.value === 'boolean' : type === 'enum' ? Array.isArray(capability.allowed) && capability.allowed.includes(p.value) : ['int', 'float', 'number'].includes(type) && typeof p.value === 'number' && Number.isFinite(p.value) && (capability.min === undefined || p.value >= capability.min) && (capability.max === undefined || p.value <= capability.max) && (!(capability.step > 0) || Math.abs((p.value - (capability.min || 0)) / capability.step - Math.round((p.value - (capability.min || 0)) / capability.step)) <= 1e-6);
    if (!valid) return refuse('Choose a valid value for this setting');
    if (p.value === now.value) { logAttempt({ ...base, outcome: 'done', detail: 'Already set; nothing sent' }, req); return { success: true, value: now.value, unchanged: true, status: 'noop' }; }
    let result;
    try { result = await require('./dongle').changePhocosSetting(dev.name, setting.name, p.expected, p.value); }
    catch (e) { result = { ok: false, status: 'sent_unverified', error: e.message }; }
    const status = result.status || (result.ok ? 'verified' : result.written ? 'sent_unverified' : 'refused');
    const outcome = ['done', 'verified', 'noop'].includes(status) ? 'done' : status === 'refused' ? 'refused' : status === 'sent_unverified' || status === 'unverified' ? 'unverified' : 'failed';
    const readback = result.readback && typeof result.readback === 'object' && Object.prototype.hasOwnProperty.call(result.readback, 'value') ? result.readback.value : result.readback;
    const hasReadback = result.readback !== undefined && result.readback !== null;
    const reason = result.reason || result.error || null;
    logAttempt({ ...base, outcome, detail: reason || status }, req);
    const response = { success: ['done', 'verified'].includes(status), ...(hasReadback ? { value: readback } : {}), ...(result.written || ['sent_unverified', 'unverified', 'mismatch'].includes(status) ? { written: true } : {}), ...(status === 'noop' || result.unchanged ? { unchanged: true } : {}), status };
    if (!response.success) response.error = reason || (status === 'mismatch' ? 'Device read-back did not match the requested value' : status === 'sent_unverified' || status === 'unverified' ? 'The write was sent but could not be verified' : 'The setting change was refused');
    else if (reason) response.error = reason;
    return response;
  }
  const want = toRaw(setting, p.value);
  if (want.error) return refuse(want.error);

  const now = await readSetting(dev.name, setting.name);
  if (now.error) return refuse(`Could not read the current value first: ${now.error}`);
  base.oldValue = now.value;
  if (!now.inRange) return refuse(`The device reports ${now.value}${setting.unit ? ' ' + setting.unit : ''} for this setting, outside ${setting.min}–${setting.max}. It may not mean what this profile says on your device, so it was not changed.`);
  if (p.expected !== undefined && p.expected !== null && p.expected !== '' && Number(p.expected) !== now.value) {
    return refuse(`It changed since you looked: it is now ${now.value}${setting.unit ? ' ' + setting.unit : ''}. Check the new value and try again.`, { current: now.value });
  }
  for (const [rel, other] of [['below', setting.below], ['above', setting.above]]) {
    if (!other) continue;
    const o = dev.settings.find(s => s.name === other);
    if (!o) continue;
    const ov = await readSetting(dev.name, o.name);
    if (ov.error) return refuse(`Could not read ${o.label} to check against it: ${ov.error}`);
    const target = toValue(setting, want.raw);
    if (rel === 'below' && !(target < ov.value)) return refuse(`Must be below ${o.label} (${ov.value}${o.unit ? ' ' + o.unit : ''})`);
    if (rel === 'above' && !(target > ov.value)) return refuse(`Must be above ${o.label} (${ov.value}${o.unit ? ' ' + o.unit : ''})`);
  }
  if (want.raw === now.raw) {
    logAttempt({ ...base, outcome: 'done', detail: 'Already set; nothing written' }, req);
    return { success: true, value: now.value, unchanged: true };
  }

  const wrote = await require('./dongle').writeDongleSetting(dev.name, setting.register, setting.register_type, want.raw);
  if (wrote.error) { logAttempt({ ...base, outcome: 'failed', detail: wrote.error }, req); return { success: false, error: wrote.error }; }
  const back = await readSetting(dev.name, setting.name);
  if (back.error) {
    logAttempt({ ...base, outcome: 'unverified', detail: `Written, but reading it back failed: ${back.error}` }, req);
    return { success: false, written: true, error: `The change was sent, but reading it back failed (${back.error}). Read it again to check.` };
  }
  if (back.raw !== want.raw) {
    logAttempt({ ...base, outcome: 'failed', detail: `Read back ${back.value} instead` }, req);
    return { success: false, written: true, value: back.value, error: `The device now reports ${back.value}${setting.unit ? ' ' + setting.unit : ''}, not the new value. It may have refused or limited it.` };
  }
  logAttempt({ ...base, outcome: 'done', detail: 'Read back and matched' }, req);
  return { success: true, value: back.value };
}

/**
 * Expert register write: any 16-bit register on a dongle or Modbus device.
 * LuxPower registers are read before and after; others report the write only.
 * @param {object} p - { kind: 'dongle'|'modbus', device, register, value }
 */
async function rawWrite(p, req) {
  const dongle = require('./dongle');
  const base = { source: 'expert', device: p.device, target: String(p.register), newValue: p.value };
  const refuse = detail => { logAttempt({ ...base, outcome: 'refused', detail }, req); return { success: false, error: detail }; };
  const off = writeRefusal({ raw: true });
  if (off) return refuse(off);
  const addr = dongle.registerWord(p.register);
  const value = dongle.registerWord(p.value, { decimalOnly: true });
  if (addr === null) return refuse('Invalid register address');
  if (value === null) return refuse('The value must be a whole number from 0 to 65535');
  base.target = '0x' + addr.toString(16).padStart(4, '0').toUpperCase();
  let result, before = null, after = null;
  if (p.kind === 'modbus') {
    result = await require('./modbus').executeModbusAction(p.device, addr, value, p.type === 'coil' ? 'coil' : undefined);
  } else {
    const isLux = (() => { try { const d = JSON.parse(getConfig('dongle_config') || '[]').find(x => x && x.name === p.device); const pr = d && dongle.getProfileById(d.profile); return !!pr && pr.protocol === 'luxpower-tcp'; } catch { return false; } })();
    if (isLux) {
      const r = await dongle.readDongleRegister(p.device, addr, 'holding');
      if (r.error) return refuse(`Could not read the register first: ${r.error}`);
      before = r.value; base.oldValue = before;
      result = await dongle.writeLuxpowerRaw(p.device, addr, value);
      if (!result.error) { const b = await dongle.readDongleRegister(p.device, addr, 'holding'); after = b.error ? null : b.value; }
    } else {
      result = await dongle.executeDongleAction(p.device, addr, value);
    }
  }
  if (result.error) { logAttempt({ ...base, outcome: 'failed', detail: result.error }, req); return { success: false, error: result.error }; }
  if (after !== null && after !== value) {
    logAttempt({ ...base, outcome: 'failed', detail: `Read back ${after} instead` }, req);
    return { success: false, written: true, before, after, error: `The device now reports ${after}, not ${value}.` };
  }
  logAttempt({ ...base, outcome: after === null ? 'unverified' : 'done', detail: after === null ? 'Sent; this connection can\'t read it back' : 'Read back and matched' }, req);
  return { success: true, before, after };
}

/** Read any register (expert panel). LuxPower dongles only for now. */
async function rawRead(p) {
  const dongle = require('./dongle');
  if (p.kind !== 'dongle') return { error: 'Reading registers is available for LuxPower dongles only for now' };
  return dongle.readDongleRegister(p.device, p.register, p.type === 'input' ? 'input' : 'holding');
}

module.exports = {
  listedSettingFor,
  UNLOCK_MS,
  writesEnabled, expertEnabled, setSwitches, writeRefusal,
  unlockedUntil, unlock, lock, requireUnlocked,
  logAttempt, recentLog,
  settingsOf, listDevices, readSetting, changeSetting, toRaw, toValue, rawWrite, rawRead
};
