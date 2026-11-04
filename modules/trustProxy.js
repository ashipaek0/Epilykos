'use strict';
/**
 * What Express believes about X-Forwarded-For / -Proto, from TRUST_PROXY.
 *
 * Every rate limit and the "Secure" cookie flag depend on it. Believing the
 * header from anyone lets a client write any address into it and start a new
 * rate-limit bucket on every request, so the default believes it only from the
 * machine itself: a Cloudflare Tunnel, Tailscale or a reverse proxy running
 * next to Epilykos all connect from there.
 *
 *   (unset)             loopback only (127.0.0.1 and ::1)
 *   false | 0 | off     believe nobody
 *   a number            that many proxies in front (1 = one proxy)
 *   addresses or CIDRs  those, comma separated (172.16.0.0/12, 10.0.0.5)
 *   loopback, uniquelocal, linklocal   Express's named ranges
 *
 * A reverse proxy in another container or on another machine must be named
 * here; until then everyone behind it shares one rate-limit bucket.
 *
 * @module modules/trustProxy
 */
function resolveTrustProxy(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return 'loopback';
  if (/^(false|0|off|no|none)$/i.test(text)) return false;
  if (/^\d+$/.test(text)) return Number(text);
  if (/^(true|on|yes)$/i.test(text)) {
    // `true` would believe anyone, which is the problem this module exists to avoid.
    return 'loopback';
  }
  return text.split(',').map(part => part.trim()).filter(Boolean);
}

module.exports = { resolveTrustProxy };
