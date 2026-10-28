/** Maintenance reminders; local snapshots do not replace an off-device backup. */
'use strict';
const { getConfig, setConfig, DB_PATH, unreadableSecrets } = require('./database');
const { readSpace } = require('./storageStatus');
const path = require('node:path');
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
  const dataStorage = host.available() ? readSpace(path.dirname(DB_PATH)) : null;
  if (dataStorage && (dataStorage.state === 'warning' || dataStorage.state === 'critical')) {
    notices.push({ id: 'data-space', severity: dataStorage.state,
      message: dataStorage.state === 'critical'
        ? 'DATA is critically low on free space. Monitoring may stop when storage fills. Review storage and backup options.'
        : 'DATA free space is low. Review storage before creating backups, restoring data or installing updates.',
      href: '/settings#system' });
  }
  const lost = unreadableSecrets().filter(label => !/made again automatically/.test(label));
  if (lost.length) {
    notices.push({ id: 'secrets', severity: 'warning',
      message: `This box cannot read some saved passwords and tokens: ${lost.join(', ')}. They were saved with a different encryption key, usually because a backup was restored onto a new box. Enter them again in Settings. The old box's data/encryption-key would bring them back.`,
      href: '/settings' });
  }
  if (database.last && !database.last.ok) notices.push({ id: 'database', message: 'The database check found problems. Download a backup and review restore options.', href: '/settings#backup' });
  if (backup.due) notices.push({ id: 'backup', message: 'Save a backup somewhere outside this appliance. Your last download was over 30 days ago, or no download has been recorded.', href: '/settings#backup' });
  if (cachedHost && cachedHost.storage && cachedHost.storage.undersized) notices.push({ id: 'storage', message: 'This SD card is smaller than 32 GB. Snapshots and restore space may not fit; use a 32 GB or larger card (64 GB recommended).', href: '/settings#system' });
  if (clock && clock.synchronized === false) notices.push({ id: 'clock', message: 'The appliance clock is not synchronized. New readings may have incorrect times.', href: '/settings#system' });
  return { backup, database, clock, data_storage: dataStorage, notices };
}
module.exports = { status, backupState, MONTH_MS };
