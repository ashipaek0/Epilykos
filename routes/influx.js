/**
 * /api/influx (signed in): Settings → InfluxDB, the database a user already keeps their readings in.
 *
 *   GET    /                  the connection (never its password or token), the mapping, the write settings and the
 *                             metric names Epilykos has (for the mapping's suggestions)
 *   POST   /connection        save the connection; an empty password or token keeps the saved one for the same server
 *   POST   /test              can Epilykos reach this server, with these credentials and this database or bucket?
 *   POST   /disconnect        forget the connection (the mapping is kept)
 *   POST   /discover          what the saved connection holds: measurements, or for { measurement } its fields and tag
 *                             names, or for { measurement, tagKey } that tag's values
 *   POST   /suggest-ha        mapping rows for Home Assistant's InfluxDB integration layout
 *   POST   /mapping           save the mapping
 *   POST   /write-settings    save where new readings are written
 *   POST   /import/plan       what an import of the mapped metrics' history would read, and the room it needs
 *   POST   /import/start      start it (it runs in the background; GET / shows its progress)
 *   POST   /import/stop       stop it after the week in progress
 *
 * @module routes/influx
 */
const express = require('express');
const { getConfig, setConfig, getDb } = require('../modules/database');
const { createInfluxClient, InfluxError } = require('../modules/influx/client');
const s = require('../modules/influx/settings');
const service = require('../modules/influx/service');

const router = express.Router();
const fail = (res, status, message) => res.status(status).json({ error: message });
const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const SUGGEST_MAX_MEASUREMENTS = 100;

function knownMetrics() {
  try { return getDb().prepare('SELECT metric FROM latest_metrics ORDER BY metric').all().map(r => r.metric); } catch (_) { return []; }
}

function view() {
  const conn = s.loadConnection();
  const state = service.loadState();
  return {
    connection: s.connectionView(conn), configured: s.isConfigured(conn), mapping: s.loadMapping(), write: s.loadWrite(), metrics: knownMetrics(),
    connectedAt: state.connectedAt || null, import: service.getImporter().status(), writing: service.getWriter().status(),
  };
}

/** A client for `conn`, or a 400 sent and null returned. Tests may replace `router.clientFor`. */
function clientOr400(res, conn) {
  try { return router.clientFor(conn); } catch (e) { fail(res, 400, e.message); return null; }
}
router.clientFor = conn => createInfluxClient(conn);

const influxFailure = (res, e) => {
  if (e instanceof InfluxError) return fail(res, e.kind === 'config' ? 400 : 422, e.message);
  return fail(res, 500, 'Could not talk to InfluxDB');
};

router.get('/', (req, res) => res.json(view()));

router.post('/connection', (req, res) => {
  const next = s.mergeConnection(body(req));
  if (!clientOr400(res, next)) return;   // the same checks a test makes, before anything is saved
  setConfig(s.CONNECTION_KEY, JSON.stringify(next));
  service.noteConnected();
  res.json(view());
});

router.post('/test', async (req, res) => {
  const client = clientOr400(res, s.mergeConnection(body(req)));
  if (!client) return;
  try { res.json(await client.test()); } catch (e) { influxFailure(res, e); }
});

router.post('/disconnect', (req, res) => {
  setConfig(s.CONNECTION_KEY, '');
  res.json(view());
});

function savedClient(res) {
  const conn = s.loadConnection();
  if (!s.isConfigured(conn)) { fail(res, 400, 'Save the InfluxDB connection first'); return null; }
  return clientOr400(res, conn);
}

router.post('/discover', async (req, res) => {
  const client = savedClient(res);
  if (!client) return;
  const { measurement, tagKey } = body(req);
  try {
    if (typeof measurement === 'string' && measurement && typeof tagKey === 'string' && tagKey) return res.json({ values: await client.tagValues(measurement, tagKey) });
    if (typeof measurement === 'string' && measurement) {
      const [fields, tagKeys] = await Promise.all([client.fieldKeys(measurement), client.tagKeys(measurement)]);
      return res.json({ fields, tagKeys });
    }
    res.json({ measurements: await client.measurements() });
  } catch (e) { influxFailure(res, e); }
});

router.post('/suggest-ha', async (req, res) => {
  const client = savedClient(res);
  if (!client) return;
  try {
    const measurements = (await client.measurements()).slice(0, SUGGEST_MAX_MEASUREMENTS);
    const found = [];
    for (const measurement of measurements) {
      const [fields, tagKeys] = await Promise.all([client.fieldKeys(measurement), client.tagKeys(measurement)]);
      if (!tagKeys.includes('entity_id') || !fields.some(f => f.name === 'value')) continue;
      found.push({ measurement, entityIds: await client.tagValues(measurement, 'entity_id') });
    }
    if (!found.length) return res.json({ rows: [], message: 'No Home Assistant series found: none has an entity_id tag and a value field.' });
    res.json({ rows: s.suggestHomeAssistant(found, knownMetrics()) });
  } catch (e) { influxFailure(res, e); }
});

router.post('/mapping', (req, res) => {
  const result = s.validateMapping(body(req).mapping);
  if (result.error) return fail(res, 400, result.error);
  setConfig(s.MAPPING_KEY, JSON.stringify(result.mapping));
  res.json(view());
});

router.post('/write-settings', (req, res) => {
  setConfig(s.WRITE_KEY, JSON.stringify(s.normaliseWrite(body(req))));
  res.json(view());
});

router.post('/import/plan', async (req, res) => {
  if (!savedClient(res)) return;
  if (!s.loadMapping().length) return fail(res, 400, 'Add the metrics to read first');
  try { res.json(await service.getImporter().plan()); } catch (e) { influxFailure(res, e); }
});

router.post('/import/start', async (req, res) => {
  if (!savedClient(res)) return;
  const importer = service.getImporter();
  if (importer.isRunning()) return fail(res, 409, 'An import is already running');
  if (!s.loadMapping().length) return fail(res, 400, 'Add the metrics to read first');
  try {
    importer.start(await importer.plan());
    res.json(view());
  } catch (e) { e instanceof InfluxError ? influxFailure(res, e) : fail(res, 400, e.message); }
});

router.post('/import/stop', async (req, res) => {
  await service.getImporter().stop();
  res.json(view());
});

module.exports = router;
