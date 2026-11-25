/**
 * Metric setup routes (mounted at /api): the role metrics (which metric is Solar, Home use, battery, grid), the Virtual
 * Battery (a state of charge counted from the inverters' battery current) and the combined metrics (definitions, the last
 * cycle's status, and a preview). Signed-in only.
 *
 * @module routes/metricConfig
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, setConfig, getDb } = require('../modules/database');
const { isAuthenticated } = require('../modules/sessionAuth');

const router = express.Router();

router.use('/role-metrics', isAuthenticated);
router.get('/role-metrics', (req, res) => {
  const raw = getConfig('role_metrics');
  res.json(raw ? JSON.parse(raw) : {});
});
router.post('/role-metrics', (req, res) => {
  const mapping = req.body;
  if (typeof mapping !== 'object' || mapping === null) return res.status(400).json({ error: 'Expected JSON object' });
  setConfig('role_metrics', JSON.stringify(mapping));
  logger.info('[role-metrics] Updated mapping:', mapping);
  res.json({ success: true });
});

// Virtual Battery (Settings > Virtual Battery): SOC from counting the inverters' battery current.
router.use('/battery-estimator', isAuthenticated);
function batteryEstimatorView() {
  const be = require('../modules/batteryEstimator');
  let saved = {};
  try { saved = JSON.parse(getConfig(be.CONFIG_KEY) || '{}') || {}; } catch (_) { saved = {}; }
  const chemistries = Object.fromEntries(Object.entries(be.CHEMISTRY).map(([k, { curve, ...v }]) => [k, v]));
  const suggestions = be.suggestions(), detected = be.detectNominal(suggestions);
  return { settings: saved, effective: be.settings(saved, detected), detected_nominal: detected, status: be.getStatus(), suggestions, chemistries };
}
router.get('/battery-estimator', (req, res) => res.json(batteryEstimatorView()));
router.post('/battery-estimator', (req, res) => {
  try { require('../modules/batteryEstimator').saveSettings(req.body && req.body.settings); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(batteryEstimatorView());
});
router.post('/battery-estimator/soc', (req, res) => {
  try { require('../modules/batteryEstimator').setSoc(req.body && req.body.soc); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(batteryEstimatorView());
});

// Combined metrics (Settings > Metrics): definitions, last-cycle status, preview.
router.use('/combined-metrics', isAuthenticated);
router.get('/combined-metrics', (req, res) => {
  const cm = require('../modules/combinedMetrics');
  res.json({ definitions: cm.loadDefinitions(), status: cm.getCombinedStatus(), functions: cm.FNS, auto_labels: cm.autoLabels() });
});
router.post('/combined-metrics', (req, res) => {
  const cm = require('../modules/combinedMetrics');
  const defs = Array.isArray(req.body?.definitions) ? req.body.definitions : null;
  if (!defs || defs.length > 100) return res.status(400).json({ error: 'Expected up to 100 definitions.' });
  const clean = [];
  for (const raw of defs) {
    const def = {
      id: typeof raw.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(raw.id) ? raw.id : `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: String(raw.name || '').trim(), unit: String(raw.unit || '').trim().slice(0, 12), enabled: raw.enabled !== false,
      fn: raw.fn, inputs: (Array.isArray(raw.inputs) ? raw.inputs : []).map(x => String(x || '').trim()).filter(Boolean)
    };
    for (const k of ['weights', 'factor', 'offset', 'input_unit', 'start', 'stale_seconds', 'missing', 'note', 'when', 'on_at', 'off_at', 'daily', 'days', 'include_today']) if (raw[k] !== undefined && raw[k] !== '') def[k] = raw[k];
    if (def.weights) def.weights = def.weights.map(Number);
    for (const k of ['factor', 'offset', 'start', 'stale_seconds', 'on_at', 'off_at']) if (def[k] !== undefined) def[k] = Number(def[k]);
    if (def.days !== undefined) def.days = Number(def.days);   // average per day: the last N days (empty = every day on record)
    if (typeof def.note === 'string') def.note = def.note.slice(0, 200);
    // Names shown for the inputs on cards that list the parts: { input: label }, only for inputs in use.
    if (raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)) {
      const labels = {};
      for (const input of def.inputs) { const l = typeof raw.labels[input] === 'string' ? raw.labels[input].trim().slice(0, 40) : ''; if (l) labels[input] = l; }
      if (Object.keys(labels).length) def.labels = labels;
    }
    const errors = cm.validateDefinition(def, clean);
    if (errors.length) return res.status(400).json({ error: `${def.name || 'A combined metric'}: ${errors[0]}`, errors });
    clean.push(def);
  }
  const { cyclic } = cm.orderDefinitions(clean);
  if (cyclic.length) return res.status(400).json({ error: `These combined metrics use each other in a loop: ${cyclic.join(', ')}.` });
  setConfig(cm.CONFIG_KEY, JSON.stringify(clean));
  try { cm.pruneState(clean); } catch (err) { logger.warn('[combined] could not tidy state:', err.message); }
  // List each combined metric with its unit, so pickers and the data-spike guard know it.
  try {
    const list = JSON.parse(getConfig('user_metrics') || '[]');
    let changed = false;
    for (const d of clean) {
      const row = list.find(m => m && m.name === d.name);
      if (!row) { list.push({ name: d.name, unit: d.unit, createdAt: Date.now(), combined: true }); changed = true; }
      else if (d.unit && row.unit !== d.unit) { row.unit = d.unit; changed = true; }
    }
    if (changed) setConfig('user_metrics', JSON.stringify(list));
  } catch (err) { logger.warn('[combined] could not list metrics:', err.message); }
  logger.info(`[combined] saved ${clean.length} combined metrics`);
  res.json({ success: true, definitions: clean });
});
router.post('/combined-metrics/preview', (req, res) => {
  const cm = require('../modules/combinedMetrics');
  const def = req.body || {};
  const errors = cm.validateDefinition(def);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const { flushMetrics } = require('../modules/database');
  flushMetrics();
  const stmt = getDb().prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?'), now = Math.floor(Date.now() / 1000);
  const inputs = def.inputs.map(name => {
    const row = stmt.get(String(name).trim());
    const ts = row ? (Number(row.timestamp) > 1e12 ? Math.floor(row.timestamp / 1000) : Number(row.timestamp)) : null;
    return { name, value: row ? row.value : null, age: ts == null ? null : now - ts };
  });
  const result = cm.evaluate(def, name => { const r = stmt.get(String(name).trim()); if (!r || r.value == null) return null; return { value: Number(r.value), timestamp: Number(r.timestamp) > 1e12 ? Math.floor(r.timestamp / 1000) : Number(r.timestamp) }; }, null, now);
  const energy = ['energy_today', 'energy_total', 'counter_today'].includes(def.fn);
  res.json({ inputs, value: result.skip ? null : result.value, skip: result.skip || null, note: energy ? 'Energy and daily counters start counting once saved.' : def.fn === 'threshold' ? 'Between the two limits it keeps its last state, and starts Off.' : result.note || null });
});

module.exports = router;
module.exports.batteryEstimatorView = batteryEstimatorView;
