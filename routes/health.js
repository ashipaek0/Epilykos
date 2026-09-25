/**
 * GET /healthz — unauthenticated liveness/readiness probe.
 *
 * Used by the Docker HEALTHCHECK and, on EpilykosOS, by the Podman
 * HealthCmd that gates systemd readiness and RAUC slot confirmation
 * (C-RUNTIME-002, C-BOOT-003). It proves only that the application started:
 * the process serves HTTP and SQLite opens with the expected schema. It must
 * never depend on the network, Internet, BLE or inverters, and it exposes no
 * secrets or configuration values.
 *
 * 200 { status: 'ok', ... } when healthy, 503 { status: 'error', ... } when not.
 *
 * @module routes/health
 */
const express = require('express');
const { getDb, getDurabilitySettings, METRIC_FLUSH_INTERVAL_MS } = require('../modules/database');
const { timeZoneName } = require('../modules/localTime');
const { version } = require('../package.json');

const REQUIRED_TABLES = ['config', 'metrics', 'latest_metrics', 'history'];
const startedAt = Date.now();

function checkHealth() {
  const db = getDb();
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  const missing = REQUIRED_TABLES.filter(t => !present.has(t));
  if (missing.length) throw new Error(`schema incomplete: missing ${missing.join(', ')}`);
  db.prepare('SELECT 1 FROM config LIMIT 1').get();
  return getDurabilitySettings();
}

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const base = {
    version,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
    timezone: timeZoneName()
  };
  try {
    const durability = checkHealth();
    res.json({ status: 'ok', ...base, database: { ...durability, metric_flush_interval_ms: METRIC_FLUSH_INTERVAL_MS } });
  } catch (err) {
    // Reason only — never paths, stack traces or configuration.
    res.status(503).json({ status: 'error', ...base, error: err.message.replace(/\/[^\s]+/g, '<path>') });
  }
});

module.exports = { router, checkHealth };
