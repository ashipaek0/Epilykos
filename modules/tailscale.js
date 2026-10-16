'use strict';
/**
 * Remote access with Tailscale (Settings → Network → Remote access).
 *
 * tailscaled runs inside this container in userspace networking mode, so it
 * needs no extra Docker permissions, and only once the user turns remote access
 * on. Its state lives in data/tailscale (not in the database, so a restored
 * backup never copies this device's Tailscale identity).
 *
 *   connect()     start tailscaled, `tailscale up`; the user signs in at the
 *                 sign-in link with their own account (their own tailnet)
 *   serve         `tailscale serve --bg <port>`: HTTPS on <name>.<tailnet>.ts.net,
 *                 reachable only from the user's own Tailscale devices
 *   funnel        `tailscale funnel --bg <port>`: the same address from any
 *                 browser (off by default; routes ask for the password)
 *   disconnect()  `tailscale logout`, then stop tailscaled
 *
 * When the tailnet hasn't enabled HTTPS or Funnel yet, `serve`/`funnel` print a
 * login.tailscale.com link to enable it and wait: that link is passed on.
 * The image ships Tailscale's latest stable release (see the Dockerfile).
 * Written against the CLI source at v1.102.5: `up --json` (AuthURL),
 * `status --json` (Version, BackendState, AuthURL, Self {DNSName, Online,
 * CapMap}, CurrentTailnet), `serve status --json` (AllowFunnel), `serve reset`.
 * Tailscale marks --json output "subject to change", so only these long-standing
 * fields are read and a missing one counts as unknown, not as an error.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { logger } = require('./logger');

const DIR = path.resolve(process.env.TAILSCALE_STATE_DIR || path.join('data', 'tailscale'));
const SOCKET = path.join(DIR, 'tailscaled.sock');
const BIN = process.env.TAILSCALE_BIN || 'tailscale';
const DAEMON = process.env.TAILSCALED_BIN || 'tailscaled';
const PENDING_MS = 15 * 60 * 1000;     // sign-in / enable links stay open this long
const LINK = /https:\/\/login\.tailscale\.com\/\S+/;

let runner = { spawn, execFile };      // replaced in tests
let daemon = null, wanted = false, restartDelay = 2000, restartTimer = null;
let pending = { up: null, serve: null };   // long-running CLI calls waiting on the user
let lastLink = { signIn: null, enable: null };
let installed = null;

function setRunnerForTests(r) { runner = r; installed = null; }

/** Whether this image includes Tailscale (the Docker image does; development checkouts may not). */
function isInstalled() {
  if (installed !== null) return Promise.resolve(installed);
  return new Promise(resolve => {
    runner.execFile(BIN, ['version'], { timeout: 5000 }, err => { installed = !err; resolve(installed); });
  });
}

function cli(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    runner.execFile(BIN, [`--socket=${SOCKET}`, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      resolve(String(stdout));
    });
  });
}

function waitForSocket(ms = 15000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function check() {
      if (fs.existsSync(SOCKET)) return resolve();
      if (Date.now() > until) return reject(new Error('Tailscale did not start'));
      setTimeout(check, 200);
    })();
  });
}

/** Start tailscaled (userspace networking) and keep it running while remote access is on. */
async function startDaemon() {
  wanted = true;
  if (daemon) return waitForSocket();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCKET); } catch (_) { /* not there */ }
  const child = runner.spawn(DAEMON, ['--tun=userspace-networking', `--statedir=${DIR}`, `--socket=${SOCKET}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemon = child;
  const log = line => { if (line.trim()) logger.debug(`[tailscale] ${line.trim()}`); };
  for (const stream of [child.stdout, child.stderr]) if (stream) stream.on('data', d => String(d).split('\n').forEach(log));
  child.on('error', err => logger.warn(`[tailscale] could not start tailscaled: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (daemon === child) daemon = null;
    if (!wanted) return;
    logger.warn(`[tailscale] tailscaled stopped (${signal || code}); restarting in ${Math.round(restartDelay / 1000)} s`);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { startDaemon().catch(e => logger.warn(`[tailscale] ${e.message}`)); }, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
  await waitForSocket();
  restartDelay = 2000;
  logger.info('[tailscale] tailscaled started (userspace networking)');
}

function stopDaemon() {
  wanted = false;
  clearTimeout(restartTimer);
  for (const k of Object.keys(pending)) { if (pending[k]) { try { pending[k].kill(); } catch (_) {} pending[k] = null; } }
  if (daemon) { try { daemon.kill('SIGTERM'); } catch (_) {} daemon = null; }
}

/**
 * Run a CLI call that may wait for the user (sign in, enable HTTPS/Funnel).
 * Resolves with { done: true } when it finishes, or { link } as soon as it
 * prints a login.tailscale.com link; it then keeps waiting in the background.
 */
function runWaiting(kind, args) {
  if (pending[kind]) { try { pending[kind].kill(); } catch (_) {} }
  return new Promise((resolve, reject) => {
    const child = runner.spawn(BIN, [`--socket=${SOCKET}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    pending[kind] = child;
    let out = '', settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, PENDING_MS);
    const onData = d => {
      out += String(d);
      const m = LINK.exec(out);
      if (m) finish({ link: m[0].replace(/["',]+$/, '') });
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', err => { clearTimeout(timer); if (!settled) { settled = true; reject(err); } });
    child.on('exit', code => {
      clearTimeout(timer);
      if (pending[kind] === child) {
        pending[kind] = null;
        // The link it printed is only good while it waits.
        if (kind === 'up') lastLink.signIn = null; else lastLink.enable = null;
      }
      if (code === 0) finish({ done: true });
      else if (!settled) { settled = true; reject(new Error(out.trim().split('\n').slice(-3).join(' ') || `tailscale ${args[0]} failed (${code})`)); }
    });
  });
}

function hasCap(self, cap) {
  if (!self) return false;
  if (self.CapMap && Object.prototype.hasOwnProperty.call(self.CapMap, cap)) return true;
  return Array.isArray(self.Capabilities) && self.Capabilities.includes(cap);
}

/** Plain summary for Settings. state: off | starting | needs-login | running | stopped. */
async function status() {
  const base = { installed: await isInstalled(), enabled: wanted };
  if (!base.installed) return { ...base, state: 'not-installed' };
  if (!wanted) return { ...base, state: 'off' };
  if (!daemon || !fs.existsSync(SOCKET)) return { ...base, state: 'starting' };
  let st;
  try { st = JSON.parse(await cli(['status', '--json', '--peers=false'], 10000)); }
  catch (e) { return { ...base, state: 'starting', error: e.message }; }
  const self = st.Self || {};
  const dnsName = String(self.DNSName || '').replace(/\.$/, '');
  const out = {
    ...base,
    state: st.BackendState === 'Running' ? 'running' : st.BackendState === 'NeedsLogin' || st.BackendState === 'NeedsMachineAuth' ? 'needs-login' : st.BackendState === 'Stopped' ? 'stopped' : 'starting',
    backendState: st.BackendState,
    version: st.Version ? String(st.Version).split('-')[0] : null,
    signInLink: st.BackendState === 'Running' ? null : (st.AuthURL || (pending.up && lastLink.signIn) || null),
    needsApproval: st.BackendState === 'NeedsMachineAuth',
    dnsName: dnsName || null,
    tailnet: (st.CurrentTailnet && st.CurrentTailnet.Name) || null,
    online: !!self.Online,
    ips: st.TailscaleIPs || [],
    httpsAllowed: hasCap(self, 'https'),
    funnelAllowed: hasCap(self, 'funnel'),
    enableLink: (pending.serve && lastLink.enable) || null,
    serving: false, funnel: false,
  };
  if (out.state === 'running') {
    try {
      const sc = JSON.parse((await cli(['serve', 'status', '--json'], 10000)) || '{}');
      out.serving = !!(sc.Web && Object.keys(sc.Web).length);
      out.funnel = !!(sc.AllowFunnel && Object.values(sc.AllowFunnel).some(Boolean));
    } catch (_) { /* serve status unavailable */ }
    out.privateUrl = out.serving && dnsName ? `https://${dnsName}` : null;
  }
  return out;
}

function hostname(name) {
  return String(name || 'epilykos').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'epilykos';
}

/** Start Tailscale and sign in. Resolves with the status (signInLink while waiting). */
async function connect({ name } = {}) {
  await startDaemon();
  const res = await runWaiting('up', ['up', '--json', `--hostname=${hostname(name)}`]);
  if (res.link) lastLink.signIn = res.link;
  return status();
}

/** HTTPS on the tailnet name, for the user's own devices. */
async function servePrivately(port) {
  const res = await runWaiting('serve', ['serve', '--bg', '--yes', String(port)]);
  if (res.link) lastLink.enable = res.link;
  return status();
}

/** Open (or close) the same address to any browser with Funnel. */
async function setFunnel(on, port) {
  if (on) {
    const res = await runWaiting('serve', ['funnel', '--bg', '--yes', String(port)]);
    if (res.link) lastLink.enable = res.link;
    return status();
  }
  // `funnel … off` removes the whole HTTPS serve: reset, then serve privately again.
  await cli(['serve', 'reset']);
  return servePrivately(port);
}

/** Leave the tailnet and stop Tailscale. */
async function disconnect() {
  if (daemon && fs.existsSync(SOCKET)) {
    try { await cli(['serve', 'reset']); } catch (_) { /* nothing served */ }
    try { await cli(['logout'], 20000); } catch (e) { logger.warn(`[tailscale] logout: ${e.message}`); }
  }
  stopDaemon();
  lastLink = { signIn: null, enable: null };
  return status();
}

module.exports = { status, connect, servePrivately, setFunnel, disconnect, startDaemon, stopDaemon, isInstalled, hostname, setRunnerForTests, SOCKET, DIR };
