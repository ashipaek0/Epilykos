/**
 * Controls API (/api/controls/*), for the signed-in Controls page. Mounted
 * behind isAuthenticated and the global CSRF check; anything that changes a
 * device or the write switches also needs the password unlock.
 *
 * @module routes/controls
 */
const express = require('express');
const controls = require('../modules/deviceControls');
const { verifyPassword, loginLimiter } = require('../modules/sessionAuth');

const router = express.Router();
const body = req => (req.body && typeof req.body === 'object' ? req.body : {});
const text = (v, max = 128) => (typeof v === 'string' && v.length <= max ? v : null);

function status(req) {
  return { unlockedUntil: controls.unlockedUntil(req) || null, unlockMinutes: controls.UNLOCK_MS / 60000,
    writesEnabled: controls.writesEnabled(), expertEnabled: controls.expertEnabled(), now: Date.now() };
}

router.get('/status', (req, res) => res.json(status(req)));

router.post('/unlock', loginLimiter, (req, res) => {
  const ok = verifyPassword(body(req).password);
  controls.logAttempt({ source: 'unlock', label: 'Unlock changes', outcome: ok ? 'done' : 'refused', detail: ok ? 'Changes unlocked' : 'Wrong password' }, req);
  if (!ok) return res.status(401).json({ error: 'That password is not right' });
  controls.unlock(req);
  res.json(status(req));
});

router.post('/lock', (req, res) => { controls.lock(req); res.json(status(req)); });

router.post('/switches', controls.requireUnlocked, (req, res) => {
  const b = body(req);
  const enabled = typeof b.enabled === 'boolean' ? b.enabled : undefined;
  const expert = typeof b.expert === 'boolean' ? b.expert : undefined;
  if (enabled === undefined && expert === undefined) return res.status(400).json({ error: 'Nothing to change' });
  if (expert === true && !(enabled === true || controls.writesEnabled())) return res.status(400).json({ error: 'Turn on changing device settings first' });
  const before = status(req);
  controls.setSwitches({ enabled, expert });
  const after = status(req);
  controls.logAttempt({ source: 'switches', target: enabled !== undefined ? 'Allow device changes' : 'Expert register writes',
    oldValue: enabled !== undefined ? before.writesEnabled : before.expertEnabled, newValue: enabled !== undefined ? after.writesEnabled : after.expertEnabled, outcome: 'done' }, req);
  res.json(after);
});

router.get('/devices', (req, res) => res.json({ devices: controls.listDevices(), ...status(req) }));

router.post('/read', async (req, res) => {
  const b = body(req);
  const device = text(b.device), setting = text(b.setting, 64);
  if (!device || !setting) return res.status(400).json({ error: 'device and setting are required' });
  const r = await controls.readSetting(device, setting);
  res.status(r.error ? 502 : 200).json(r);
});

router.post('/change', controls.requireUnlocked, async (req, res) => {
  const b = body(req);
  const device = text(b.device), setting = text(b.setting, 64);
  if (!device || !setting) return res.status(400).json({ error: 'device and setting are required' });
  const r = await controls.changeSetting({ device, setting, value: b.value, expected: b.expected }, req);
  res.status(r.success ? 200 : (r.written ? 502 : 409)).json(r);
});

router.post('/raw-read', async (req, res) => {
  const b = body(req);
  if (!controls.expertEnabled()) return res.status(403).json({ error: 'Turn on expert register writes to read registers' });
  const device = text(b.device);
  if (!device) return res.status(400).json({ error: 'device is required' });
  const r = await controls.rawRead({ kind: b.kind === 'modbus' ? 'modbus' : 'dongle', device, register: b.register, type: b.type });
  res.status(r.error ? 502 : 200).json(r);
});

router.post('/raw-write', controls.requireUnlocked, async (req, res) => {
  const b = body(req);
  const device = text(b.device);
  if (!device) return res.status(400).json({ error: 'device is required' });
  const r = await controls.rawWrite({ kind: b.kind === 'modbus' ? 'modbus' : 'dongle', device, register: b.register, value: b.value, type: b.type }, req);
  res.status(r.success ? 200 : 409).json(r);
});

router.get('/log', (req, res) => res.json({ entries: controls.recentLog(req.query.limit) }));

module.exports = router;
