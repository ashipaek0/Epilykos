'use strict';
/**
 * Shared HTTP plumbing for the channels: network errors name the host only
 * (Telegram's and Discord's URLs carry the secret), and HTTP errors say
 * whether a retry could help (4xx other than 408/429 will not).
 */

async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    throw new Error(`Could not reach ${new URL(url).host}: ${e.message}`);
  }
}

/** Error for a non-2xx response; `detailKey` names the JSON field with the reason. */
async function httpError(label, res, detailKey) {
  let detail = '';
  if (detailKey) {
    try { detail = (await res.json())[detailKey] || ''; } catch (_) { /* not JSON */ }
  }
  const err = new Error(`${label} ${res.status}${detail ? ': ' + detail : ''}`);
  err.status = res.status;
  err.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  return err;
}

/** POST a JSON body; throws a request/httpError on failure. */
async function postJson(fetchImpl, url, body, { headers = {}, label, detailKey } = {}) {
  const res = await request(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw await httpError(label, res, detailKey);
  return res;
}

module.exports = { request, httpError, postJson };
