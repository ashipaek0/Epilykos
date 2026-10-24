'use strict';
/**
 * EpilykosOS updates from Settings → Updates (OS update design §10). The
 * appliance does all the work (host actions os_status, os_check, os_install,
 * os_cancel, os_restart, os_discard, os_dismiss); this module relays them
 * and reshapes the host's answer into `host.os` for the page.
 *
 * Installing names the exact signed package the last check offered
 * (sequence and SHA-256), so a stale page can never install something
 * else, plus a request ID so a repeated click is the same job. Passwords
 * are checked by the route and never sent to the host.
 */
const crypto = require('crypto');
const hostActions = require('./hostActions');
const { getConfig, setConfig } = require('./database');

const TERMINAL = ['confirmed', 'rolled_back', 'failed', 'cancelled', 'discarded'];
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSUPPORTED = 'This EpilykosOS version cannot install system updates from Settings yet. '
  + 'They become available after its next update.';

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function unknownAction(reply) {
  return !!reply && reply.ok !== true && /unknown action/i.test(String(reply.error || ''));
}

/** The host's `os` view as the page's `host.os` (design §10.2). */
function shape(os, offer) {
  if (!os) return null;
  const job = os.job || null;
  const terminal = !!job && TERMINAL.includes(job.state);
  const progress = (job && job.progress) || {};
  const latest = os.candidate || (offer && offer.latest) || null;
  return {
    version: os.version || null,
    sequence: Number.isSafeInteger(os.sequence) ? os.sequence : null,
    channel: os.channel || null,
    supported: os.supported === true,
    unsupported_reason: os.supported === true ? null : (os.reason || UNSUPPORTED),
    guard: os.guard || null,
    available: !!(os.available ?? (offer && offer.available)),
    latest_version: latest ? latest.version : null,
    latest_sequence: latest ? latest.sequence : null,
    latest,
    blockers: Array.isArray(os.blockers) ? os.blockers : (offer && offer.blockers) || [],
    trust_update: !!os.trust_update,
    error: os.error || null,
    job: job && !terminal ? {
      id: job.id, state: job.state, version: job.version || null, sequence: job.sequence ?? null,
      bytes: progress.bytes ?? null, total: progress.total ?? null, percent: progress.percent ?? null,
      message: progress.message || '', error: job.error || null, started_at: job.created_at || null,
    } : null,
    last_result: terminal ? {
      id: job.id, outcome: job.state, version: job.version || null, sequence: job.sequence ?? null,
      reason: job.error || null, finished_at: job.updated_at || null,
    } : null,
  };
}

function lastOffer() {
  try { return JSON.parse(getConfig('update_os_offer') || 'null'); } catch (_) { return null; }
}

async function call(action, params = {}, timeoutMs = 15000) {
  if (!hostActions.available()) throw httpError(404, 'Not running on EpilykosOS');
  const reply = await hostActions.call(action, params, { timeoutMs });
  if (unknownAction(reply)) throw httpError(409, UNSUPPORTED);
  if (!reply || reply.ok !== true) throw httpError(400, (reply && reply.error) || 'The appliance refused');
  return reply;
}

/** `host.os` now; null off EpilykosOS. Never throws. */
async function status() {
  if (!hostActions.available()) return null;
  try {
    const reply = await hostActions.call('os_status', {}, { timeoutMs: 5000 });
    if (unknownAction(reply)) return { supported: false, unsupported_reason: UNSUPPORTED, available: false, job: null, last_result: null };
    if (!reply || reply.ok !== true) return null;
    return shape(reply.os, lastOffer());
  } catch (_) {
    return null;
  }
}

/** Ask the appliance whether a newer signed system is out and can install. */
async function check() {
  const reply = await call('os_check', {}, 60000);
  const os = reply.os || {};
  const offer = os.available && os.candidate
    ? { available: true, latest: os.candidate, blockers: os.blockers || [], checkedAt: new Date().toISOString() }
    : { available: false, latest: null, blockers: [], checkedAt: new Date().toISOString() };
  setConfig('update_os_offer', JSON.stringify(offer));
  if (offer.available) notifyOnce(offer.latest);
  return shape(os, offer);
}

function notifyOnce(latest) {
  const id = `os-seq:${latest.sequence}`;
  if (getConfig('update_notified_os') === id) return;
  setConfig('update_notified_os', id);
  const { emitEvent } = require('./notifications/events');
  emitEvent('update.available', { subject: 'EpilykosOS', message: `EpilykosOS ${latest.version} is ready. Open Settings → Updates to install it.`, data: { os: latest.version } });
}

/** Install exactly what the last check offered. */
async function install({ sequence, sha256, requestId } = {}) {
  const offer = lastOffer();
  const latest = offer && offer.available ? offer.latest : null;
  if (!latest || latest.sequence !== sequence || latest.sha256 !== sha256) {
    throw httpError(409, 'The available system update changed. Check again, then install.');
  }
  const request = typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(requestId) ? requestId : crypto.randomUUID();
  const reply = await call('os_install', { sequence, sha256, request_id: request }, 60000);
  return shape(reply.os, offer);
}

function jobAction(action) {
  return async (job) => {
    if (typeof job !== 'string' || !JOB_ID.test(job)) throw httpError(400, 'Which update? Reload the page and try again.');
    const reply = await call(action, { job }, 30000);
    return shape(reply.os, lastOffer());
  };
}

module.exports = {
  shape, status, check, install, lastOffer, UNSUPPORTED,
  cancel: jobAction('os_cancel'), restart: jobAction('os_restart'),
  discard: jobAction('os_discard'), dismiss: jobAction('os_dismiss'),
};
