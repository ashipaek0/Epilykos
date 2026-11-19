'use strict';
/**
 * Setup health: what is and isn't set up, as a list the Settings → Health page shows.
 *
 * evaluate(facts) is pure: it takes facts already read from the settings and the database and returns
 * [{ id, level: 'ok' | 'warn' | 'fail', title, detail, fix }] in a fixed order. `fail` is only for things that
 * stop the dashboard working; everything else that is merely worth doing is `warn`. `fix` is where in Settings
 * to go (a hash such as "#backup"), or '' when there is nothing to do. Nothing here reads a file or the network.
 */

const STALE_READING_S = 15 * 60;
const BACKUP_STALE_DAYS = 3;
const DISK_FAIL_MB = 200, DISK_WARN_MB = 1024;
const ROLES = [['solar', 'solar'], ['consumption', 'load'], ['battery_soc', 'battery charge'], ['grid_import', 'grid import']];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function ago(seconds) {
  if (seconds < 90) return 'a minute ago';
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

/**
 * @param {object} f facts:
 *   now (seconds), sourcesConfigured (n), newestReading (seconds or null), roles ({role: metric}),
 *   timeZone (string), location ({lat, lon} or null), snapshots ({count, newest (seconds or null), overdue, error}),
 *   cloudBackup (bool), twoStep (bool), notifications ({enabled, channels, devices}), diskFreeMb (n or null)
 */
function evaluate(f) {
  const out = [];
  const add = (id, level, title, detail, fix = '') => out.push({ id, level, title, detail, fix });

  // Data
  if (!f.sourcesConfigured) add('source', 'fail', 'No data source yet', 'Add the inverter, battery or meter Epilykos should read.', '#sources');
  else if (f.newestReading == null) add('source', 'warn', 'No readings yet', `${plural(f.sourcesConfigured, 'source is', 'sources are')} set up but nothing has been read. Check the connection.`, '#sources');
  else if (f.now - f.newestReading > STALE_READING_S) add('source', 'fail', 'Readings have stopped', `The newest reading is from ${ago(f.now - f.newestReading)}. Check that the source is on and reachable.`, '#sources');
  else add('source', 'ok', 'Receiving readings', `${plural(f.sourcesConfigured, 'source', 'sources')} set up, newest reading ${ago(Math.max(0, f.now - f.newestReading))}.`);

  // Roles
  const roles = f.roles || {};
  const missing = ROLES.filter(([k]) => !roles[k]).map(([, label]) => label);
  if (missing.length === ROLES.length) add('roles', 'warn', 'Metric roles not chosen', 'Cards and totals use roles to know which metric is solar, load, battery and grid.', '#metrics');
  else if (!roles.solar || !roles.consumption) add('roles', 'warn', 'Some metric roles are missing', `Still to choose: ${missing.join(', ')}.`, '#metrics');
  else add('roles', 'ok', 'Metric roles chosen', missing.length ? `Optional ones left: ${missing.join(', ')}.` : 'Solar, load, battery and grid are all set.');

  // Time zone
  const tz = String(f.timeZone || '');
  if (!tz || /^(UTC|Etc\/UTC|GMT|Etc\/GMT)$/i.test(tz)) add('timezone', 'warn', 'Time zone is UTC', 'Daily totals and charts start at midnight UTC. If you are not on UTC, set the time zone (TZ on Docker and Node, or your system clock).');
  else add('timezone', 'ok', 'Time zone set', tz + '.');

  // Location (weather and forecast)
  const loc = f.location;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || (loc.lat === 0 && loc.lon === 0)) add('location', 'warn', 'No location for weather and forecast', 'Weather and solar forecast cards need your location.', '#forecast');
  else add('location', 'ok', 'Location set', 'Weather and forecast can find you.');

  // Backups
  const s = f.snapshots || {};
  if (s.error) add('backup', 'fail', 'The last automatic backup failed', String(s.error).slice(0, 200), '#backup');
  else if (!s.count) add('backup', 'warn', 'No backup yet', 'Epilykos makes automatic snapshots, but none exists yet. Make one in Backup and restore.', '#backup');
  else if (s.overdue || (s.newest != null && f.now - s.newest > BACKUP_STALE_DAYS * 86400)) add('backup', 'warn', 'Backups are overdue', `The newest snapshot is from ${ago(f.now - s.newest)}.`, '#backup');
  else add('backup', 'ok', 'Automatic backups are running', `Newest snapshot ${ago(Math.max(0, f.now - s.newest))}.`);
  if (!f.cloudBackup) add('offsite', 'warn', 'No copy off this device', 'A backup on the same disk does not survive the disk. Send one to a folder, a WebDAV server or Google Drive.', '#backup');
  else add('offsite', 'ok', 'Backups are copied elsewhere', '');

  // Sign-in
  if (f.twoStep) add('twostep', 'ok', 'Two-step sign-in is on', '');
  else add('twostep', 'warn', 'Two-step sign-in is off', 'Add a second step to the admin sign-in, especially if Epilykos is reachable from the internet.', '#security');

  // Notifications
  const n = f.notifications || {};
  if (!n.enabled) add('notifications', 'ok', 'Notifications are off', 'Turn them on in Notifications if you want alerts.', '#notifications');
  else if (!n.channels && !n.devices) add('notifications', 'warn', 'Notifications have nowhere to go', 'They are on, but no channel or device is set up, so nothing is sent.', '#notifications');
  else add('notifications', 'ok', 'Notifications can reach you', `${plural(n.channels || 0, 'channel', 'channels')} and ${plural(n.devices || 0, 'device', 'devices')}.`);

  // Disk
  if (f.diskFreeMb != null) {
    const mb = Math.round(f.diskFreeMb);
    const text = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB free` : `${mb} MB free`;
    if (mb < DISK_FAIL_MB) add('disk', 'fail', 'Almost out of disk space', `${text}. Readings and backups can stop being saved.`, '#backup');
    else if (mb < DISK_WARN_MB) add('disk', 'warn', 'Disk space is getting low', text + '.', '#backup');
    else add('disk', 'ok', 'Plenty of disk space', text + '.');
  }
  return out;
}

/** Drop the checks a person dismissed (a failing check can't be dismissed). */
function applyDismissed(checks, dismissed) {
  const set = new Set(Array.isArray(dismissed) ? dismissed : []);
  return checks.map(c => ({ ...c, dismissed: set.has(c.id) && c.level === 'warn' }));
}

/** How many checks need attention: failures and warnings that are not dismissed. */
function attentionCount(checks) {
  return checks.filter(c => (c.level === 'fail') || (c.level === 'warn' && !c.dismissed)).length;
}

module.exports = { evaluate, applyDismissed, attentionCount, STALE_READING_S };
