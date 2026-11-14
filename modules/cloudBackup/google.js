'use strict';
/**
 * Signing in to Google from a box with no browser (the device flow), keeping the sign-in alive, and ending it.
 *
 *   start()         → a short code and an address for the person to open on any phone or computer
 *   poll(deviceCode) → 'pending' | 'slow_down' | 'done' | 'denied' | 'expired'
 *   refresh(token)  → a short-lived access token. A token Google no longer honours throws GOOGLE_REVOKED.
 *   revoke(token)   → tells Google the access is no longer wanted
 *
 * Only one permission is asked for: drive.file, which lets Epilykos see and manage the files it creates itself.
 * Nothing here reads a name, an email address or anything else about the account.
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ENDPOINTS = {
  device: 'https://oauth2.googleapis.com/device/code',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3'
};

function problem(message, code, status = 422) { return Object.assign(new Error(message), { code, status, cloudBackup: true }); }

function createGoogleAuth({ clientId, clientSecret, endpoints = {}, fetchImpl = fetch, now = Date.now } = {}) {
  const url = { ...ENDPOINTS, ...endpoints };
  const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20000) });
  async function call(target, body) {
    let res;
    try { res = await fetchImpl(target, form(body)); }
    catch (error) { throw problem('Cannot reach Google: ' + (error.cause && error.cause.code || error.message), 'GOOGLE_UNREACHABLE', 502); }
    let json = {}; try { json = await res.json(); } catch (_) { /* not JSON */ }
    return { status: res.status, json };
  }
  const available = () => Boolean(clientId && clientSecret);
  function need() { if (!available()) throw problem('Google Drive is not set up in this build of Epilykos.', 'GOOGLE_NOT_CONFIGURED', 501); }

  return {
    available,
    async start() {
      need();
      const { status, json } = await call(url.device, { client_id: clientId, scope: SCOPE });
      if (status !== 200 || !json.device_code) throw problem('Google did not start the sign-in' + (json.error_description ? ': ' + json.error_description : '.'), 'GOOGLE_START_FAILED', 502);
      return { deviceCode: json.device_code, userCode: json.user_code, verificationUrl: json.verification_url || json.verification_uri, expiresIn: Number(json.expires_in) || 1800, interval: Number(json.interval) || 5 };
    },
    async poll(deviceCode) {
      need();
      const { json } = await call(url.token, { client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (json.access_token && json.refresh_token) return { status: 'done', refreshToken: json.refresh_token, accessToken: json.access_token, expiresAt: now() + (Number(json.expires_in) || 3600) * 1000, scope: json.scope || '' };
      if (json.access_token) throw problem('Google did not give Epilykos lasting access. Try connecting again.', 'GOOGLE_NO_REFRESH');
      switch (json.error) {
        case 'authorization_pending': return { status: 'pending' };
        case 'slow_down': return { status: 'slow_down' };
        case 'access_denied': return { status: 'denied' };
        case 'expired_token': case 'invalid_grant': return { status: 'expired' };
        default: throw problem('Google refused the sign-in' + (json.error_description ? ': ' + json.error_description : ' (' + (json.error || 'unknown') + ').'), 'GOOGLE_REFUSED', 502);
      }
    },
    async refresh(refreshToken) {
      need();
      const { status, json } = await call(url.token, { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
      if (json.access_token) return { accessToken: json.access_token, expiresAt: now() + (Number(json.expires_in) || 3600) * 1000 };
      if (json.error === 'invalid_grant' || status === 400 || status === 401) throw problem('Google Drive access was removed or has expired. Connect it again.', 'GOOGLE_REVOKED', 409);
      throw problem('Google did not renew the sign-in (' + (json.error || status) + '). Trying again later may help.', 'GOOGLE_REFRESH_FAILED', 502);
    },
    async revoke(token) {
      try { await fetchImpl(url.revoke, form({ token })); } catch (_) { /* best effort: the token is forgotten here either way */ }
    },
    endpoints: url
  };
}

module.exports = { createGoogleAuth, SCOPE, ENDPOINTS };
