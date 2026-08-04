const net = require('net');
const { logger } = require('./logger');

/**
 * Parse a grid state value into a binary state.
 * @param {*} state - numeric (0/1/2.5) or text ('on'/'off', 'true'/'false',
 *                    '1'/'0', 'open'/'closed', 'unlocked'/'locked')
 * @returns {number|null} 1 = ON, 0 = OFF, null = unresolvable.
 *   'unavailable'/'unknown'/null/undefined/unrecognized → null (NOT a phantom
 *   OFF), so callers can distinguish "measured zero" from "no data".
 */
function parseGridState(state) {
  if (state === null || state === undefined) {
    logger.warn('parseGridState: null/undefined state treated as unresolvable');
    return null;
  }
  if (typeof state === 'number') return state > 0 ? 1 : 0;
  const str = String(state).toLowerCase().trim();
  if (str === '' || str === 'unavailable' || str === 'unknown') {
    logger.warn(`parseGridState: state '${str || String(state)}' is unresolvable (not OFF/ON)`);
    return null;
  }
  if (str === 'on' || str === 'true' || str === '1' || str === 'open' || str === 'unlocked') return 1;
  if (str === 'off' || str === 'false' || str === '0' || str === 'closed' || str === 'locked') return 0;
  logger.warn(`parseGridState: unrecognized state '${str}' treated as unresolvable`);
  return null;
}

/**
 * Check if an IP address is private or local.
 * @param {string} ip - IP string (v4 or v6)
 * @returns {boolean}
 */
function isPrivateOrLocalIp(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('fe80:')) return true;
  return false;
}

/**
 * Validate a hostname string (no IPs, RFC-compliant labels).
 * @param {string} value
 * @returns {boolean}
 */
function isValidHostname(value) {
  if (value.length > 253) return false;
  const labels = value.split('.');
  return labels.every(label =>
    /^[a-zA-Z0-9-]{1,63}$/.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

module.exports = { parseGridState, isPrivateOrLocalIp, isValidHostname };
