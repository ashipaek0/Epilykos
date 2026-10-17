/** Maintenance reminders; local snapshots do not replace an off-device backup. */
'use strict';
const { getConfig, setConfig } = require('./database');
const dbCheck = require('./dbCheck');
const host = require('./hostActions');
const MONTH_MS = 30 * 86400000;
let cachedHost = null, cachedAt = 0;
function backupState(now = Date.now()) {
  let first = Number(getConfig('backup_reminder_started'));
  if (!first) { first = now; setConfig('backup_reminder_started', String(first)); }
  const last = getConfig('backup_downloaded_at') || null;
  const snoozed = Number(getConfig('backup_reminder_until')) || 0;
  const age = now - (Date.parse(last) || first);
  return { last, due: now >= snoozed && age >= MONTH_MS };
}
async function status(now = Date.now()) {
  const backup = backupState(now), database = { last: dbCheck.last(), running: dbCheck.busy() };
  if (host.available() && now - cachedAt > 60000) {
    try { const r = await host.call('status'); if (r.ok) { cachedHost = r; cachedAt = now; } } catch (_) {}
  }
  let clock = cachedHost && cachedHost.clock;
  if (process.env.EPILYKOS_CLOCK_FILE) {
    try { const fs = require('fs'); const path = process.env.EPILYKOS_CLOCK_FILE;
      clock = Date.now() - fs.statSync(path).mtimeMs < 60000 ? JSON.parse(fs.readFileSync(path, 'utf8')) : { synchronized: false };
    } catch (_) { clock = { synchronized: false }; }
  }
  const notices = [];
  if (database.last && !database.last.ok) notices.push({ id: 'database', message: 'The database check found problems. Download a backup and review restore options.', href: '/settings#backup' });
  if (backup.due) notices.push({ id: 'backup', message: 'Save a backup somewhere outside this appliance. Your last download was over 30 days ago, or no download has been recorded.', href: '/settings#backup' });
  if (cachedHost && cachedHost.storage && cachedHost.storage.undersized) notices.push({ id: 'storage', message: 'This SD card is smaller than 32 GB. Snapshots and restore space may not fit; use a 32 GB or larger card (64 GB recommended).', href: '/settings#system' });
  if (clock && clock.synchronized === false) notices.push({ id: 'clock', message: 'The appliance clock is not synchronized. New readings may have incorrect times.', href: '/settings#system' });
  return { backup, database, clock, notices };
}
module.exports = { status, backupState, MONTH_MS };
