/**
 * Automations API (/api/automations/*), for the signed-in Automations page.
 * Mounted behind isAuthenticated and the global CSRF check. Saving or
 * enabling an automation needs the password unlock (it will change devices
 * on its own from then on); turning things off, taking over, testing and
 * deleting do not.
 *
 * @module routes/automations
 */
const express = require('express');
const controls = require('../modules/deviceControls');
const automations = require('../modules/automations');
const { logger } = require('../modules/logger');

const router = express.Router();
const { store, engine } = automations;
const body = req => (req.body && typeof req.body === 'object' ? req.body : {});
const actor = req => (req.session && (req.session.username || req.session.user)) || 'admin';
const idOf = req => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
const HOUR = 3600000;

function view(a, nowMs) {
  return { ...a, status: engine.status(a.id), takenOver: store.isTakenOver(a, nowMs) };
}
function summary(req) {
  const nowMs = Date.now();
  return { paused: automations.isPaused(), now: nowMs, unlockedUntil: controls.unlockedUntil(req) || null, unlockMinutes: controls.UNLOCK_MS / 60000,
    automations: store.list().map(a => view(a, nowMs)) };
}
const audit = (req, label, a, detail) => controls.logAttempt({ source: 'automations', label, target: a && a.name, device: a && String(a.id), outcome: 'done', detail }, req);

router.get('/', (req, res) => res.json(summary(req)));

/** What can be changed, and the metrics a condition can use. */
router.get('/catalog', (req, res) => {
  const now = Date.now();
  let metrics = {};
  try { metrics = require('../modules/metrics').getCurrentMetrics(); } catch (_) { /* empty */ }
  res.json({
    targets: automations.buildCatalog(),
    metrics: Object.entries(metrics).map(([name, m]) => ({ name, value: m.value, unit: m.unit || '', ageS: Math.max(0, Math.round((now - Number(m.timestamp)) / 1000)) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

router.get('/runs', (req, res) => res.json({ runs: store.recentRuns(req.query.limit, idOf({ params: { id: req.query.id } })) }));

router.post('/validate', (req, res) => { const v = automations.validate(body(req)); res.json({ ok: v.ok, errors: v.errors }); });

/** What the automation would do right now. Reads devices, sends nothing. */
router.post('/dry-run', async (req, res) => {
  const v = automations.validate(body(req));
  if (!v.ok) return res.status(400).json({ error: v.errors.join('. '), errors: v.errors });
  try { res.json(await engine.dryRun(v.def)); } catch (e) { logger.error('Automation dry run:', e.message); res.status(500).json({ error: 'Could not test it' }); }
});

router.post('/', controls.requireUnlocked, (req, res) => {
  const v = automations.validate(body(req));
  if (!v.ok) return res.status(400).json({ error: v.errors.join('. '), errors: v.errors });
  const a = store.create(v.def, actor(req));
  audit(req, 'Automation created', a, v.def.enabled ? 'enabled' : 'off');
  res.status(201).json(view(a, Date.now()));
});

router.put('/:id', controls.requireUnlocked, (req, res) => {
  const id = idOf(req);
  if (!id || !store.get(id)) return res.status(404).json({ error: 'Not found' });
  const v = automations.validate(body(req));
  if (!v.ok) return res.status(400).json({ error: v.errors.join('. '), errors: v.errors });
  const a = store.update(id, v.def, actor(req));
  audit(req, 'Automation changed', a);
  res.json(view(a, Date.now()));
});

router.delete('/:id', (req, res) => {
  const id = idOf(req), a = id && store.get(id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  store.remove(id);
  audit(req, 'Automation deleted', a);
  res.json({ success: true });
});

router.post('/:id/enable', controls.requireUnlocked, (req, res) => {
  const id = idOf(req);
  if (!id || !store.get(id)) return res.status(404).json({ error: 'Not found' });
  const a = store.setEnabled(id, true, actor(req));
  audit(req, 'Automation turned on', a);
  res.json(view(a, Date.now()));
});
router.post('/:id/disable', (req, res) => {
  const id = idOf(req);
  if (!id || !store.get(id)) return res.status(404).json({ error: 'Not found' });
  const a = store.setEnabled(id, false, actor(req));
  audit(req, 'Automation turned off', a);
  res.json(view(a, Date.now()));
});

/** Take over: stop one automation for `hours` (1 by default, up to 72), or until resumed. */
router.post('/:id/takeover', (req, res) => {
  const id = idOf(req);
  if (!id || !store.get(id)) return res.status(404).json({ error: 'Not found' });
  const b = body(req);
  const hours = Number(b.hours);
  const until = b.untilResumed === true ? -1 : Date.now() + (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 72) : 1) * HOUR;
  const a = store.setPause(id, until);
  audit(req, 'Automation taken over', a, until === -1 ? 'until resumed' : `for ${Math.round((until - Date.now()) / 60000)} min`);
  res.json(view(a, Date.now()));
});
router.post('/:id/resume', (req, res) => {
  const id = idOf(req);
  if (!id || !store.get(id)) return res.status(404).json({ error: 'Not found' });
  const a = store.setPause(id, 0);
  audit(req, 'Automation resumed', a);
  res.json(view(a, Date.now()));
});

/** Pause every automation at once. Pausing needs no unlock; starting again does. */
router.post('/pause-all', (req, res, next) => (body(req).paused === false ? controls.requireUnlocked(req, res, next) : next()), (req, res) => {
  const paused = body(req).paused !== false;
  automations.setPaused(paused);
  controls.logAttempt({ source: 'automations', label: paused ? 'Automations paused' : 'Automations resumed', outcome: 'done' }, req);
  res.json(summary(req));
});

module.exports = router;
