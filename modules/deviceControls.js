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
/** Express middleware: 423 unless this session unlocked changes recently. */
function requireUnlocked(req, res, next) {
  if (unlockedUntil(req)) return next();
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
  if (!profile || !profile.capabilities || profile.capabilities.write !== true) return [];
  return (Array.isArray(profile.writable_registers) ? profile.writable_registers : [])
    .filter(w => w && w.name && w.register && (w.kind || 'value') === 'value')
    .map(w => ({
      name: w.name, label: w.label || w.name, description: w.description || '', unit: w.unit || '',
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
      rawReads: !!profile && profile.protocol === 'luxpower-tcp' });
  }
  let modbus = [];
  try { modbus = JSON.parse(getConfig('modbus_devices') || '[]').filter(d => d && d.enabled); } catch { modbus = []; }
  for (const d of modbus) out.push({ name: d.name, kind: 'modbus', profile: d.profile || '', profileName: d.profile || 'Modbus', transport: 'modbus', settings: [], rawWrites: true, rawReads: false });
  return out;
}

function findSetting(deviceName, settingName) {
  const dev = listDevices().find(d => d.kind === 'dongle' && d.name === deviceName);
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
  base.label = setting.label;
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
  UNLOCK_MS,
  writesEnabled, expertEnabled, setSwitches, writeRefusal,
  unlockedUntil, unlock, lock, requireUnlocked,
  logAttempt, recentLog,
  settingsOf, listDevices, readSetting, changeSetting, toRaw, toValue, rawWrite, rawRead
};
