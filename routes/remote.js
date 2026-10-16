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
 *
 *   GET  /api/remote/cloudflare             status (never the token)
 *   POST /api/remote/cloudflare/connect     { token, publicUrl, password }: the
 *                                           tunnel's address is public, so the
 *                                           same password rule as Funnel
 *   POST /api/remote/cloudflare/disconnect  stop the tunnel, forget the token
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, setConfig } = require('../modules/database');
const tailscale = require('../modules/tailscale');
const cloudflared = require('../modules/cloudflared');
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

/** The admin password, 12+ characters, before anything is opened to the internet. Returns an error reply or null. */
function publicAccessRefusal(password, what) {
  if (typeof password !== 'string' || !verifyPassword(password)) return { status: 403, body: { error: `Enter your admin password to open the dashboard to the internet${what ? ` with ${what}` : ''}.` } };
  if (password.length < FUNNEL_MIN_PASSWORD) return { status: 400, body: { error: `Your admin password is shorter than ${FUNNEL_MIN_PASSWORD} characters. Change it to a longer one first: anyone on the internet will be able to try it.`, code: 'weak_password' } };
  return null;
}

function cloudflareConfig() {
  try { return JSON.parse(getConfig('cloudflare_tunnel') || '{}') || {}; } catch (_) { return {}; }
}

/** "https://energy.example.com" from what was typed; null when empty, throws when not a plain address. */
function normalisePublicUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`); } catch (_) { u = null; }
  if (!u || u.protocol !== 'https:' || !u.hostname.includes('.') || (u.pathname && u.pathname !== '/') || u.search || u.hash) {
    throw new Error('Enter the public hostname you set on the tunnel, for example energy.example.com.');
  }
  return `https://${u.host}`;
}

async function cloudflareStatus() {
  const cfg = cloudflareConfig();
  const st = await cloudflared.status();
  const out = { ...st, publicUrl: cfg.public_url || null, tunnelId: cfg.tunnel_id || null, port: PORT() };
  if (out.publicUrl && out.state === 'connected') out.urlQr = await require('qrcode').toString(out.publicUrl, { type: 'svg', margin: 1, width: 180 });
  return out;
}

function router() {
  const r = express.Router();
  r.use(express.json());

  r.get('/cloudflare', (req, res) => {
    cloudflareStatus().then(st => res.json(st), err => res.status(500).json({ error: err.message }));
  });

  r.post('/cloudflare/connect', async (req, res) => {
    const body = req.body || {};
    const refusal = publicAccessRefusal(body.password, 'a Cloudflare Tunnel');
    if (refusal) return res.status(refusal.status).json(refusal.body);
    let parsed, publicUrl;
    try { parsed = cloudflared.parseToken(body.token); publicUrl = normalisePublicUrl(body.publicUrl); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!(await cloudflared.isInstalled())) return res.status(400).json({ error: 'Cloudflare Tunnel is not included in this install. Update to the latest Epilykos image.' });
    setConfig('cloudflare_tunnel', JSON.stringify({ enabled: true, token: parsed.token, tunnel_id: parsed.tunnelId, public_url: publicUrl }));
    cloudflared.start(parsed.token);
    logger.warn(`[cloudflared] Dashboard opened to the internet through Cloudflare Tunnel ${parsed.tunnelId}${publicUrl ? ` (${publicUrl})` : ''}`);
    if (publicUrl && !getConfig('network_remote_url')) {
      setConfig('network_remote_url', publicUrl);
      setConfig('cloudflare_filled_remote_url', publicUrl);
    }
    const st = await cloudflareStatus();
    res.json({ ...st, filledRemoteUrl: getConfig('cloudflare_filled_remote_url') === publicUrl && !!publicUrl });
  });

  r.post('/cloudflare/disconnect', async (req, res) => {
    cloudflared.stop();
    setConfig('cloudflare_tunnel', JSON.stringify({ enabled: false }));
    const filled = getConfig('cloudflare_filled_remote_url');
    if (filled && getConfig('network_remote_url') === filled) setConfig('network_remote_url', '');
    setConfig('cloudflare_filled_remote_url', '');
    logger.info('[cloudflared] Cloudflare Tunnel turned off');
    res.json(await cloudflareStatus());
  });

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
      const refusal = publicAccessRefusal(req.body && req.body.password);
      if (refusal) return res.status(refusal.status).json(refusal.body);
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

/** At startup: bring Tailscale and the Cloudflare Tunnel back if they were on. */
function init() {
  const cf = cloudflareConfig();
  if (cf.enabled && cf.token) {
    cloudflared.isInstalled().then(ok => {
      if (ok) { cloudflared.start(cf.token); logger.info('[cloudflared] Cloudflare Tunnel back on after restart'); }
      else logger.warn('[cloudflared] The Cloudflare Tunnel is on, but cloudflared is not included in this install');
    });
  }
  if (getConfig('tailscale_enabled') !== 'true') return;
  tailscale.isInstalled().then(ok => {
    if (!ok) { logger.warn('[tailscale] Remote access is on, but Tailscale is not included in this install'); return; }
    return tailscale.startDaemon().then(() => logger.info('[tailscale] Remote access back on after restart'));
  }).catch(e => logger.warn(`[tailscale] could not start: ${e.message}`));
}

module.exports = { router, init, fillRemoteUrl, normalisePublicUrl, FUNNEL_MIN_PASSWORD };
