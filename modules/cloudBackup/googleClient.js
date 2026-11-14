'use strict';
/**
 * The Google sign-in client Epilykos uses for Google Drive backups.
 *
 * This is a client of the "TVs and Limited Input devices" kind: Google documents that its secret is not
 * confidential, because it ships inside the app, so the id and secret can live in the open-source code.
 * Until they are filled in (or set with EPILYKOS_GOOGLE_CLIENT_ID and EPILYKOS_GOOGLE_CLIENT_SECRET, for a
 * fork that registers its own), Google Drive shows as not set up in this build.
 */
module.exports = {
  clientId: process.env.EPILYKOS_GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.EPILYKOS_GOOGLE_CLIENT_SECRET || ''
};
