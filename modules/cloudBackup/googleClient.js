'use strict';
/**
 * The Google sign-in client Epilykos uses for Google Drive backups (the app registered with Google as a client
 * for devices without a keyboard).
 *
 * The client id is public: it appears in every sign-in address. The client secret is not kept in the source,
 * because secret scanners rightly refuse it there. Google documents that this kind of client's secret is not
 * confidential, since it ships inside the app, so it is added at build time: the Docker builds write it to
 * google-client.json from the repository's GOOGLE_CLIENT_SECRET secret. A build without it, such as a fork that
 * has not registered its own client, shows Google Drive as not set up.
 *
 * Environment variables override both, for a fork or a box with its own registration:
 *   EPILYKOS_GOOGLE_CLIENT_ID, EPILYKOS_GOOGLE_CLIENT_SECRET
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'google-client.json');
const CLIENT_ID = '582142276434-27f6nhah57j5v6qeg2po67ddqkj9rbag.apps.googleusercontent.com';

function load(env = process.env, file = FILE) {
  let fromFile = {};
  try { fromFile = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { /* no file in this build */ }
  return {
    clientId: String(env.EPILYKOS_GOOGLE_CLIENT_ID || fromFile.clientId || CLIENT_ID),
    clientSecret: String(env.EPILYKOS_GOOGLE_CLIENT_SECRET || fromFile.clientSecret || '')
  };
}

module.exports = load();
Object.defineProperty(module.exports, 'load', { value: load });   // not listed with the two values
