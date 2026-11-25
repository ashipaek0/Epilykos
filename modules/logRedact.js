'use strict';
/**
 * A request address made safe to write to the access log: the value of a query parameter that carries a secret
 * (token, key, password, code, …) and the secret segment of the PVOutput webhook address are replaced, so a log that is
 * shared or downloaded does not hold them.
 *
 * @module logRedact
 */

const SECRET_PARAM = /^(?:token|access_token|refresh_token|api_?key|key|secret|password|pass|passwd|code|auth|authorization|sig|signature)$/i;
const WEBHOOK_PATH = /(\/api\/pvoutput\/webhook\/)[^/?#]+/;

function redactUrl(url) {
  let text = String(url == null ? '' : url);
  text = text.replace(WEBHOOK_PATH, '$1[hidden]');
  const q = text.indexOf('?');
  if (q === -1) return text;
  const hash = text.indexOf('#', q);
  const query = text.slice(q + 1, hash === -1 ? undefined : hash);
  const kept = query.split('&').map(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    let name = pair.slice(0, eq);
    try { name = decodeURIComponent(name); } catch (_) { /* compare as written */ }
    return SECRET_PARAM.test(name) ? `${pair.slice(0, eq)}=[hidden]` : pair;
  }).join('&');
  return text.slice(0, q + 1) + kept + (hash === -1 ? '' : text.slice(hash));
}

module.exports = { redactUrl };
