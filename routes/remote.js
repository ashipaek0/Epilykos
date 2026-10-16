'use strict';
/**
 * Settings → Network → Remote access (Tailscale). Signed-in only: mounted
 * behind isAuthenticated, so remote access can only be turned on after the
 * admin password exists (the first visitor sets it on a new install).
 *
 *   GET  /api/remote/tailscale              status
 *   POST /api/remote/tailscale/connect      start + sign in (returns the sign-in link)
 *   POST /api/remote/tailscale/serve        HTTPS address for the user's own devices
 *   POST /api/remote/tailscale/funnel       { on, password } open it to any browser:
 *                                           needs the admin password, 12+ characters
 *   POST /api/remote/tailscale/disconnect   leave the tailnet, stop Tailscale
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, setConfig } = require('../modules/database');
const tailscale = require('../modules/tailscale');
const { verifyPassword } = require('../modules/sessionAuth');

const PORT = () => parseInt(process.env.PORT, 10) || 3000;
const FUNNEL_MIN_PASSWORD = 12;

/** "Address away from home": filled with the Tailscale address only when empty. */
function fillRemoteUrl(st) {
  if (!st || !st.privateUrl) return st;
  if (!getConfig('network_remote_url')) {
    setConfig('network_remote_url', st.privateUrl);
    setConfig('tailscale_filled_remote_url', st.privateUrl);
    logger.info(`[tailscale] Address away from home set to ${st.privateUrl}`);
    st.filledRemoteUrl = true;
  }
  return st;
}

/** QR codes for the sign-in link and the address, drawn here so nothing leaves the box. */
async function withQr(st) {
  const qr = text => require('qrcode').toString(text, { type: 'svg', margin: 1, width: 180 });
  if (st && st.signInLink) st.signInQr = await qr(st.signInLink);
  if (st && st.privateUrl) st.urlQr = await qr(st.privateUrl);
  return st;
}

function send(res, promise) {
  promise.then(st => withQr(fillRemoteUrl(st))).then(st => res.json(st)).catch(err => {
    logger.warn(`[tailscale] ${err.message}`);
    res.status(502).json({ error: err.message });
  });
}

function router() {
  const r = express.Router();
  r.use(express.json());

  r.get('/tailscale', (req, res) => send(res, tailscale.status()));

  r.post('/tailscale/connect', (req, res) => {
    setConfig('tailscale_enabled', 'true');
    logger.info('[tailscale] Remote access turned on');
    send(res, tailscale.isInstalled().then(ok => {
      if (!ok) throw new Error('Tailscale is not included in this install. Update to the latest Epilykos image.');
      return tailscale.connect({ name: 'epilykos' });
    }));
  });

  r.post('/tailscale/serve', (req, res) => send(res, tailscale.servePrivately(PORT())));

  r.post('/tailscale/funnel', (req, res) => {
    const on = !!(req.body && req.body.on);
    if (on) {
      const password = req.body && req.body.password;
      if (typeof password !== 'string' || !verifyPassword(password)) {
        return res.status(403).json({ error: 'Enter your admin password to open the dashboard to the internet.' });
      }
      if (password.length < FUNNEL_MIN_PASSWORD) {
        return res.status(400).json({ error: `Your admin password is shorter than ${FUNNEL_MIN_PASSWORD} characters. Change it to a longer one first: anyone on the internet will be able to try it.`, code: 'weak_password' });
      }
      logger.warn('[tailscale] Dashboard opened to the internet (Funnel on)');
    } else {
      logger.info('[tailscale] Dashboard closed to the internet (Funnel off)');
    }
    send(res, tailscale.setFunnel(on, PORT()));
  });

  r.post('/tailscale/disconnect', (req, res) => {
    setConfig('tailscale_enabled', 'false');
    logger.info('[tailscale] Remote access turned off');
    send(res, tailscale.disconnect().then(st => {
      // Clear the address only if this page filled it in and nobody changed it since.
      const filled = getConfig('tailscale_filled_remote_url');
      if (filled && getConfig('network_remote_url') === filled) setConfig('network_remote_url', '');
      setConfig('tailscale_filled_remote_url', '');
      return st;
    }));
  });

  return r;
}

/** At startup: bring Tailscale back if remote access was on. */
function init() {
  if (getConfig('tailscale_enabled') !== 'true') return;
  tailscale.isInstalled().then(ok => {
    if (!ok) { logger.warn('[tailscale] Remote access is on, but Tailscale is not included in this install'); return; }
    return tailscale.startDaemon().then(() => logger.info('[tailscale] Remote access back on after restart'));
  }).catch(e => logger.warn(`[tailscale] could not start: ${e.message}`));
}

module.exports = { router, init, fillRemoteUrl, FUNNEL_MIN_PASSWORD };
