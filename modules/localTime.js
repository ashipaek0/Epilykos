/**
 * Local-time day boundaries.
 *
 * "Today", daily buckets and savings follow the process time zone: the TZ
 * environment variable (set in docker-compose) or, when TZ is unset, the
 * host's /etc/localtime. Node's Date and SQLite's 'localtime' modifier both
 * read the same setting, so JS and SQL agree on where a day starts.
 *
 * @module localTime
 */

/** SQL expression bucketing a unix-seconds `timestamp` column by local day. */
const SQL_LOCAL_DAY = "date(timestamp, 'unixepoch', 'localtime')";

/** 'YYYY-MM-DD' for `date` in the process time zone. */
function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** IANA name of the active time zone (for logs). */
function timeZoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}

module.exports = { SQL_LOCAL_DAY, localDateString, timeZoneName };
