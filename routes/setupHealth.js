/**
 * Setup health (/api/setup-health), for Settings → Health. Signed in only. Reads settings and the database,
 * never the network, and changes only the list of dismissed checks.
 *
 * @module routes/setupHealth
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb, getConfig, setConfig } = require('../modules/database');
const { evaluate, applyDismissed, attentionCount } = require('../modules/setupHealth');

const router = express.Router();
const DISMISS_KEY = 'health_dismissed';
const SOURCE_KEYS = ['ha_devices', 'mqtt_devices', 'modbus_devices', 'rs232_devices', 'dongle_config', 'bms_devices', 'tuya_devices', 'external_sources'];

function json(key, fallback) {
  try { const v = JSON.parse(getConfig(key) || 'null'); return v == null ? fallback : v; } catch (_) { return fallback; }
}

function countSources() {
  let n = 0;
  for (const key of SOURCE_KEYS) {
    const list = json(key, []);
    if (Array.isArray(list)) n += list.filter(d => d && d.enabled !== false).length;
  }
  return n;
}

function diskFreeMb() {
  try {
    const dir = path.resolve('./data');   // where the database lives (database.js opens ./data/energy.db)
    const st = fs.statfsSync(fs.existsSync(dir) ? dir : process.cwd());
    return (Number(st.bavail) * Number(st.bsize)) / (1024 * 1024);
  } catch (_) { return null; }
}

function facts() {
  const backup = require('../modules/backup');
  const snaps = (() => { try { return backup.listSnapshots(); } catch (_) { return []; } })();
  const status = (() => { try { return backup.snapshotStatus(); } catch (_) { return {}; } })();
  const newest = snaps.length ? Math.max(...snaps.map(s => Date.parse(s.time))) / 1000 : null;
  const cloud = json('cloud_backup', {});
  const notif = require('../modules/notifications/store');
  const nSettings = notif.getSettings();
  const row = getDb().prepare('SELECT MAX(timestamp) AS t FROM latest_metrics').get();
  const lat = parseFloat(getConfig('solar_latitude')), lon = parseFloat(getConfig('solar_longitude'));
  return {
    now: Date.now() / 1000,
    sourcesConfigured: countSources(),
    newestReading: row && row.t ? Number(row.t) : null,
    roles: json('role_metrics', {}),
    timeZone: require('../modules/localTime').timeZoneName(),
    location: { lat, lon },
    snapshots: { count: snaps.length, newest, overdue: !!status.overdue, error: status.error || null },
    cloudBackup: !!(cloud && cloud.enabled),
    twoStep: require('../modules/twoStep').isEnabled(),
    notifications: { enabled: nSettings.enabled !== false, channels: notif.getChannels().filter(c => c && c.enabled !== false).length, devices: notif.getDevices().length },
    diskFreeMb: diskFreeMb(),
  };
}

function view() {
  const checks = applyDismissed(evaluate(facts()), json(DISMISS_KEY, []));
  return { checks, attention: attentionCount(checks) };
}

router.get('/', (req, res) => {
  try { res.json(view()); } catch (e) { res.status(500).json({ error: 'The health check could not run' }); }
});

// Hide (or show again) a warning. A failing check can't be hidden.
router.post('/dismiss', (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof b.id !== 'string' || !/^[a-z]{2,24}$/.test(b.id)) return res.status(400).json({ error: 'Unknown check' });
  const list = json(DISMISS_KEY, []);
  const set = new Set(Array.isArray(list) ? list : []);
  if (b.dismissed === false) set.delete(b.id); else set.add(b.id);
  setConfig(DISMISS_KEY, JSON.stringify([...set]));
  res.json(view());
});

module.exports = router;
