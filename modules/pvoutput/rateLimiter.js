/**
 * PVOutput Rate Limiter — dual-bucket token tracking with DB-persisted state.
 *
 * Two independent pools:
 *   general   — addstatus, addoutput, addbatchstatus, getsystem, getoutput, getstatus, delete
 *   statistic — getstatistic only (separate limit: 12/hr free, 60/hr donation)
 *
 * State persisted to config table under pvoutput_rate_limit_state on every update.
 * Restored on startup; ignored if resetAt is in the past (window has expired).
 *
 * @module pvoutput/rateLimiter
 */

let pools = {
  general:  { remaining: 60, limit: 60, resetAt: 0 },
  statistic: { remaining: 12, limit: 12, resetAt: 0 }
};

let db = null; // set by init()

function init(database) {
  db = database;
  // Restore persisted state
  try {
    const raw = db.prepare("SELECT value FROM config WHERE key = 'pvoutput_rate_limit_state'").get();
    if (raw && raw.value) {
      const saved = JSON.parse(raw.value);
      const now = Math.floor(Date.now() / 1000);
      if (saved.general && saved.general.resetAt > now) {
        pools.general = saved.general;
      }
      if (saved.statistic && saved.statistic.resetAt > now) {
        pools.statistic = saved.statistic;
      }
    }
  } catch (e) { /* use defaults */ }
}

function persist() {
  if (!db) return;
  try {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pvoutput_rate_limit_state', ?)")
      .run(JSON.stringify(pools));
  } catch (e) { /* non-critical */ }
}

function updateFromHeaders(pool, headers) {
  const p = pools[pool];
  if (!p) return;
  const rem = parseInt(headers['x-rate-limit-remaining']);
  const lim = parseInt(headers['x-rate-limit-limit']);
  const rst = parseInt(headers['x-rate-limit-reset']);
  if (!isNaN(rem)) p.remaining = rem;
  if (!isNaN(lim)) p.limit = lim;
  if (!isNaN(rst)) p.resetAt = rst;
  persist();
}

function canCall(pool = 'general', priority = 'normal') {
  const p = pools[pool];
  if (!p) return false;
  if (p.remaining > 10) return true;                      // comfortable
  if (p.remaining > 3 && priority === 'high') return true; // reserved for uploads
  return false;
}

function msUntilReset(pool = 'general') {
  const p = pools[pool];
  if (!p || !p.resetAt) return 0;
  return Math.max(0, (p.resetAt * 1000) - Date.now());
}

function isDonationAccount() {
  return pools.general.limit >= 300;
}

function getState() {
  return {
    general: { ...pools.general },
    statistic: { ...pools.statistic },
    donation: pools.general.limit >= 300
  };
}

module.exports = { init, updateFromHeaders, canCall, msUntilReset, isDonationAccount, getState };
