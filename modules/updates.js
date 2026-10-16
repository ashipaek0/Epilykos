'use strict';
/**
 * Is a newer Epilykos build out? (Settings → Updates)
 *
 * Each image knows which build it is (EPILYKOS_* variables set by CI, see the
 * Dockerfile). After every build CI adds the build to <channel>.json on the
 * update-feed branch (.github/scripts/update-feed.js). This module reads that
 * file once a day (and on "Check now"), compares, and remembers the result.
 *
 * A weekly rebuild has the same version and commit but a newer build: it is
 * reported as kind 'rebuild' (security updates for the base system and the
 * bundled tools), not as a new release.
 *
 * Only a plain GET to GitHub's raw file host; nothing about this install is
 * sent. Set UPDATE_CHECK=off to never check.
 */
const path = require('path');
const { logger } = require('./logger');
const { getConfig, setConfig } = require('./database');

const FEED_BASE = (process.env.UPDATE_FEED_URL || 'https://raw.githubusercontent.com/ashipaek0/Epilykos/update-feed').replace(/\/+$/, '');
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;

let fetcher = (...a) => fetch(...a);   // replaced in tests
let timer = null;

function setFetchForTests(f) { fetcher = f; }

function packageVersion() {
  try { return require(path.join(__dirname, '..', 'package.json')).version; } catch (_) { return null; }
}

/** The build this is. buildId is empty in local or development builds. */
function installed() {
  return {
    version: packageVersion(),
    channel: process.env.EPILYKOS_CHANNEL || null,
    buildId: process.env.EPILYKOS_BUILD_ID || null,
    commit: process.env.EPILYKOS_COMMIT || null,
    builtAt: process.env.EPILYKOS_BUILT_AT || null,
  };
}

function autoCheck() {
  if (/^(off|false|0|no)$/i.test(String(process.env.UPDATE_CHECK || ''))) return false;
  return getConfig('update_check_auto') !== 'false';
}

function lastStatus() {
  try { return JSON.parse(getConfig('update_status') || 'null'); } catch (_) { return null; }
}

/**
 * Compare this build with a feed file. Pure, for tests.
 * state: up-to-date | available | unknown-build
 */
function compare(mine, feed) {
  if (!mine.buildId || !mine.builtAt) return { state: 'unknown-build' };
  const latest = feed && feed.latest;
  if (!latest || !latest.buildId) throw new Error('The update feed has no builds yet');
  if (latest.buildId === mine.buildId) return { state: 'up-to-date', latest };
  const newer = (feed.history || [latest]).filter(e => e && e.builtAt && e.builtAt > mine.builtAt);
  if (!newer.length) return { state: 'up-to-date', latest };
  const notes = [];
  for (const e of newer) for (const n of e.notes || []) if (!notes.includes(n)) notes.push(n);
  const release = newer.some(e => e.kind === 'release' || e.version !== mine.version || (e.commit && e.commit !== mine.commit));
  return { state: 'available', latest, kind: release ? 'release' : 'rebuild', behind: newer.length, notes: notes.slice(0, 25) };
}

/** Check the feed now. Saves and returns the result; never throws. */
async function check() {
  const mine = installed();
  let result;
  if (!mine.buildId) {
    result = { state: 'unknown-build' };
  } else {
    const url = `${FEED_BASE}/${encodeURIComponent(mine.channel || 'latest')}.json`;
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`the update feed answered ${res.status}`);
      result = compare(mine, await res.json());
    } catch (err) {
      const prev = lastStatus();
      result = { ...(prev && prev.state !== 'error' ? prev : {}), state: prev && prev.state === 'available' ? 'available' : 'error', error: `Could not check for updates: ${err.message}` };
      logger.warn(`[updates] ${result.error}`);
    }
  }
  result.checkedAt = new Date().toISOString();
  setConfig('update_status', JSON.stringify(result));
  if (result.state === 'available') notifyOnce(result);
  return result;
}

/** One notification per new build (rules on 'update.available'). */
function notifyOnce(result) {
  const id = result.latest && result.latest.buildId;
  if (!id || getConfig('update_notified_build') === id) return;
  setConfig('update_notified_build', id);
  const { emitEvent } = require('./notifications/events');
  const what = result.kind === 'rebuild'
    ? 'Security updates for the system and the included tools are ready (no new features).'
    : `Epilykos ${result.latest.version} is ready${result.notes && result.notes.length ? `: ${result.notes.slice(0, 3).join('; ')}` : ''}.`;
  emitEvent('update.available', { subject: installed().channel || 'latest', message: `${what} Open Settings → Updates to install it.`, data: { buildId: id, version: result.latest.version, kind: result.kind } });
  logger.info(`[updates] Update available: ${result.kind} ${result.latest.version} (build ${id})`);
}

/**
 * EpilykosOS: the appliance decides what this box may install (its manifest
 * pins image digests), so its answer comes from the host (docs/host-update-actions.md).
 * Resolves the host's reply, { supported: false } on an older EpilykosOS, or null off EpilykosOS.
 */
async function hostCheck() {
  const hostActions = require('./hostActions');
  if (!hostActions.available()) return null;
  let out;
  try {
    const reply = await hostActions.call('update_check', {}, { timeoutMs: 60000 });
    if (!reply || reply.ok !== true) {
      const unsupported = /unknown action|not supported/i.test(String(reply && reply.error || ''));
      out = unsupported ? { supported: false } : { supported: true, error: (reply && reply.error) || 'The appliance could not check for updates' };
    } else {
      out = { supported: true, app: reply.app || null, os: reply.os || null };
    }
  } catch (err) {
    out = { supported: true, error: err.message };
  }
  out.checkedAt = new Date().toISOString();
  setConfig('update_host_status', JSON.stringify(out));
  if (out.os && out.os.available) notifyOsOnce(out.os);
  return out;
}

function lastHostStatus() {
  try { return JSON.parse(getConfig('update_host_status') || 'null'); } catch (_) { return null; }
}

function notifyOsOnce(os) {
  const id = `os:${os.latest_version || ''}`;
  if (!os.latest_version || getConfig('update_notified_os') === id) return;
  setConfig('update_notified_os', id);
  const { emitEvent } = require('./notifications/events');
  emitEvent('update.available', { subject: 'EpilykosOS', message: `EpilykosOS ${os.latest_version} is ready. Open Settings → Updates to install it.`, data: { os: os.latest_version } });
}

let reconcileTimer = null;

/** Daily check (first one a couple of minutes after start), and the result of an update just installed. */
function start() {
  stop();
  const dockerUpdate = require('./dockerUpdate');
  if (dockerUpdate.applying()) {
    // Just restarted by an update: the helper may still be waiting for this app to report healthy.
    let tries = 0;
    reconcileTimer = setInterval(async () => {
      const r = await dockerUpdate.reconcile();
      if (!dockerUpdate.applying() || ++tries > 40) {
        clearInterval(reconcileTimer); reconcileTimer = null;
        if (r && r.ok && installed().buildId) check().catch(() => {});
      }
    }, 15000);
    if (reconcileTimer.unref) reconcileTimer.unref();
  }
  if (!installed().buildId && !require('./hostActions').available()) return;   // local build: nothing to compare
  const run = () => {
    if (!autoCheck()) return;
    if (installed().buildId) check().catch(() => {});
    hostCheck().catch(() => {});
  };
  timer = setTimeout(function tick() { run(); timer = setTimeout(tick, DAY_MS); if (timer.unref) timer.unref(); }, FIRST_CHECK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  clearTimeout(timer); timer = null;
  clearInterval(reconcileTimer); reconcileTimer = null;
}

module.exports = { installed, compare, check, hostCheck, lastStatus, lastHostStatus, autoCheck, start, stop, setFetchForTests, FEED_BASE };
