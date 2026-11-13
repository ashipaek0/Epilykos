'use strict';
/**
 * Settings that /api/settings must never write, whoever is signed in.
 *
 * That route takes any key, because Settings sends dozens of them. These are
 * the ones with their own, stricter route, where the admin password is asked
 * for again or where only the server may decide:
 *
 *   device_writes_*      Allow device changes / expert register writes
 *                        (/api/controls/switches, behind the unlock)
 *   setup_*              first-run state: setup completion, "password set"
 *   update_*             update state and automatic installation
 *   two_step*            two-step sign-in
 *   session*, encryption*   the keys sessions and secrets rest on
 *   cloudflare_tunnel, tailscale*, remote_*   remote access (/api/remote)
 *   savings_frozen*      how far finished days are counted (modules/solarValue.js); only the server moves it
 *   cloud_backup*        off-box backup settings and status (/api/cloud-backup)
 *
 * Keys ending in _token, _password or _secret, and notification_*, are
 * refused by the route itself.
 *
 * @module modules/protectedConfig
 */
const PROTECTED = [
  /^device_writes_/i, /^setup_/i, /^update_/i, /^two_step/i,
  /^session/i, /^encryption/i, /^cloudflare_tunnel$/i, /^tailscale/i, /^remote_/i,
  /^savings_frozen/i, /^cloud_backup/i
];

function isProtectedKey(key) {
  return PROTECTED.some(pattern => pattern.test(String(key)));
}

module.exports = { isProtectedKey };
