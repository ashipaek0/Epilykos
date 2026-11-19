/**
 * /api/ha-discovery (signed in): Settings → Home Assistant.
 *
 *   GET    /           settings (never the password) and status
 *   POST   /settings   save and (re)start; an empty password keeps the saved one for the same broker and user
 *   POST   /test       can Epilykos reach this broker?
 *   POST   /remove     remove every sensor Epilykos published, and switch discovery off
 *
 * @module routes/haDiscovery
 */
const express = require('express');
const { getConfig, setConfig } = require('../modules/database');
const { CONFIG_KEY, normalise, validBroker } = require('../modules/haDiscovery');
const { service } = require('../modules/haDiscoveryService');

const router = express.Router();
const fail = (res, status, message) => res.status(status).json({ error: message });
const saved = () => { try { return normalise(JSON.parse(getConfig(CONFIG_KEY) || '{}')); } catch (_) { return normalise({}); } };

function view() {
  const s = saved();
  const { password, ...rest } = s;
  return { settings: { ...rest, hasPassword: Boolean(password) }, status: service().status() };
}

router.get('/', (req, res) => res.json(view()));

router.post('/settings', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const before = saved();
  const next = normalise({ ...before, ...body, password: typeof body.password === 'string' ? body.password : '' });
  if (!next.password && next.broker === before.broker && next.username === before.username) next.password = before.password;
  if (next.enabled && !next.broker) return fail(res, 400, 'Enter the broker address.');
  if (next.broker && !validBroker(next.broker)) return fail(res, 400, 'The broker address must start with mqtt://, mqtts://, ws:// or wss://.');
  setConfig(CONFIG_KEY, JSON.stringify(next));
  service().start();
  res.json(view());
});

router.post('/test', async (req, res) => {
  try { res.json(await service().test(req.body && typeof req.body === 'object' ? req.body : {})); }
  catch (e) { fail(res, 422, e.message || 'Could not reach the broker.'); }
});

router.post('/remove', async (req, res) => {
  try {
    const result = await service().removeAll();
    const s = saved();
    setConfig(CONFIG_KEY, JSON.stringify({ ...s, enabled: false }));
    res.json({ ...result, ...view() });
  } catch (e) { fail(res, 422, e.message || 'Could not remove the sensors.'); }
});

module.exports = router;
