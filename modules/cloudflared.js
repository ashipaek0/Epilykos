'use strict';
/**
 * Remote access with a Cloudflare Tunnel (Settings → Network). For people with
 * their own domain on Cloudflare: they create a tunnel in the Cloudflare
 * dashboard, point its public hostname at http://localhost:<port>, and paste
 * the tunnel token here. No ports to open, no reverse proxy to run.
 *
 * cloudflared runs inside this container (it then reaches the app on
 * localhost), only while the tunnel is on. The token goes in through the
 * TUNNEL_TOKEN environment variable, never the command line (process lists),
 * and is stored encrypted (SECRET_FIELDS). Readiness comes from cloudflared's
 * own /ready endpoint on a local-only metrics port.
 *
 * Checked against cloudflared 2026.10.1: `tunnel --no-autoupdate --metrics
 * <addr> run` with TUNNEL_TOKEN; /ready → { status, readyConnections }; token =
 * base64 JSON { a: account, t: tunnel id, s: secret }.
 */
const { spawn } = require('child_process');
const { logger } = require('./logger');

const BIN = process.env.CLOUDFLARED_BIN || 'cloudflared';
const METRICS = process.env.CLOUDFLARED_METRICS || '127.0.0.1:20241';

let runner = { spawn, fetch: (...a) => fetch(...a) };   // replaced in tests
let proc = null, wanted = false, token = null, restartTimer = null, restartDelay = 3000;
let lastError = null, startedAt = null, installed = null;

function setRunnerForTests(r) { runner = r; installed = null; }

/**
 * Pull the token out of what was pasted: the token itself, or the whole
 * install command Cloudflare shows ("cloudflared service install eyJ…",
 * "docker run … --token eyJ…"). Returns { token, tunnelId } or throws.
 */
function parseToken(pasted) {
  const text = String(pasted || '').trim();
  const candidates = text.match(/eyJ[A-Za-z0-9+/=_-]{40,}/g) || (text ? [text] : []);
  for (const c of candidates.sort((a, b) => b.length - a.length)) {
    try {
      const json = JSON.parse(Buffer.from(c.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (json && json.a && json.t && json.s) return { token: c, tunnelId: String(json.t) };
    } catch (_) { /* not this one */ }
  }
  throw new Error("That doesn't look like a Cloudflare tunnel token. In the Cloudflare dashboard, open your tunnel and copy the install command (or just the long code starting with eyJ).");
}

function isInstalled() {
  if (installed !== null) return Promise.resolve(installed);
  return new Promise(resolve => {
    let child;
    try { child = runner.spawn(BIN, ['--version'], { stdio: 'ignore' }); } catch (_) { installed = false; return resolve(false); }
    child.on('error', () => { installed = false; resolve(false); });
    child.on('exit', code => { installed = code === 0; resolve(installed); });
  });
}

function launch() {
  clearTimeout(restartTimer);
  lastError = null;
  startedAt = Date.now();
  const child = runner.spawn(BIN, ['tunnel', '--no-autoupdate', '--metrics', METRICS, 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUNNEL_TOKEN: token },
  });
  proc = child;
  const onLine = line => {
    const l = line.trim();
    if (!l) return;
    if (/\bERR\b|error=|Unauthorized|failed to/i.test(l)) {
      lastError = l.replace(/^\S+\s+ERR\s+/, '').slice(0, 300);
      logger.warn(`[cloudflared] ${l}`);
    } else logger.debug(`[cloudflared] ${l}`);
  };
  for (const s of [child.stdout, child.stderr]) if (s) s.on('data', d => String(d).split('\n').forEach(onLine));
  child.on('error', err => { lastError = err.message; logger.warn(`[cloudflared] could not start: ${err.message}`); });
  child.on('exit', (code, signal) => {
    if (proc === child) proc = null;
    if (!wanted) return;
    logger.warn(`[cloudflared] stopped (${signal || code}); restarting in ${Math.round(restartDelay / 1000)} s`);
    restartTimer = setTimeout(launch, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 120000);
  });
  logger.info('[cloudflared] tunnel starting');
}

/** Start (or restart with a new token). */
function start(newToken) {
  token = newToken;
  wanted = true;
  restartDelay = 3000;
  if (proc) { const old = proc; proc = null; old.removeAllListeners('exit'); try { old.kill('SIGTERM'); } catch (_) {} }
  launch();
}

function stop() {
  wanted = false;
  clearTimeout(restartTimer);
  if (proc) { try { proc.kill('SIGTERM'); } catch (_) {} proc = null; }
  token = null;
  lastError = null;
}

/** state: off | connecting | connected | error */
async function status() {
  const out = { installed: await isInstalled(), enabled: wanted };
  if (!out.installed) return { ...out, state: 'not-installed' };
  if (!wanted) return { ...out, state: 'off' };
  let ready = null;
  try {
    const res = await runner.fetch(`http://${METRICS}/ready`, { signal: AbortSignal.timeout(3000) });
    ready = await res.json().catch(() => null);
  } catch (_) { /* not up yet */ }
  const connections = ready && Number(ready.readyConnections) || 0;
  out.connections = connections;
  out.state = connections > 0 ? 'connected' : lastError && Date.now() - startedAt > 10000 ? 'error' : 'connecting';
  if (lastError) out.error = lastError;
  return out;
}

module.exports = { parseToken, start, stop, status, isInstalled, setRunnerForTests, METRICS };
