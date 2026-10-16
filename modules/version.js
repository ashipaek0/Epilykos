'use strict';
/**
 * This build's version. CI sets EPILYKOS_VERSION from git tags
 * (.github/scripts/version.js): 1.0.3 on main, 1.0.4-dev+abc1234 on dev.
 * Local builds fall back to package.json, which CI never reads.
 */
const path = require('path');

function appVersion() {
  if (process.env.EPILYKOS_VERSION) return process.env.EPILYKOS_VERSION;
  try { return require(path.join(__dirname, '..', 'package.json')).version; } catch (_) { return null; }
}

module.exports = { appVersion };
