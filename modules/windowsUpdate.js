'use strict';
/**
 * Updates for the Windows installer build (Settings → Updates).
 *
 * The installer sets EPILYKOS_INSTALLER=windows for the service. The check reads GitHub's latest release,
 * finds its Epilykos-Setup-<version>.exe, and compares the release's version with this one. Installing
 * downloads that file from this project's GitHub releases only, refuses it unless its SHA-256 matches the
 * digest GitHub publishes for the asset, then starts it silently through a one-shot scheduled task: the installer stops the service, replaces
 * the program files (the data folder is never touched) and starts the service again.
 *
 * Only plain GETs to api.github.com and github.com; nothing about this install is sent.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { appVersion } = require('./version');
const { logger } = require('./logger');
const { getConfig, setConfig } = require('./database');

const REPO = process.env.EPILYKOS_RELEASES_REPO || 'ashipaek0/Epilykos';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const ASSET = /^Epilykos-Setup-.+\.exe$/i;
const MAX_BYTES = 600 * 1024 * 1024;

let fetcher = (...a) => fetch(...a);       // replaced in tests
let schtasks = args => new Promise((resolve, reject) => execFile('schtasks.exe', args, { windowsHide: true, timeout: 30000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out))));
let tmpDir = () => os.tmpdir();
let applying = null;

function setForTests({ fetch: f, spawn: s, tmp } = {}) {
  if (f) fetcher = f;
  if (s) schtasks = s;
  if (tmp) tmpDir = tmp;
  applying = null;
}

/** True for the Windows installer build (the installer sets this for its service). */
function isWindowsInstall() {
  return process.platform === 'win32' && process.env.EPILYKOS_INSTALLER === 'windows';
}

/** [major, minor, patch] from "v1.2.3" or "1.2.3-dev+abc", or null. */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, mine) {
  const a = parseVersion(latest), b = parseVersion(mine);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The installer asset of a release, or null. Pure, for tests. */
function pickAsset(release) {
  const asset = ((release && release.assets) || []).find(a => a && ASSET.test(String(a.name || '')));
  if (!asset || !String(asset.browser_download_url || '').startsWith(DOWNLOAD_PREFIX)) return null;
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(String(asset.digest || ''));
  return { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || null, sha256: digest ? digest[1].toLowerCase() : null };
}

function lastStatus() {
  try { return JSON.parse(getConfig('windows_update_status') || 'null'); } catch (_) { return null; }
}

/** Check GitHub now. Saves and returns { state, ... }; never throws. */
async function check() {
  const mine = appVersion();
  let result;
  try {
    const res = await fetcher(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Epilykos-update-check' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    const asset = pickAsset(release);
    const latest = String(release.tag_name || '').replace(/^v/, '');
    if (!asset) result = { state: 'up-to-date', latest: { version: latest }, note: 'The newest release has no Windows installer yet.' };
    else if (!isNewer(latest, mine)) result = { state: 'up-to-date', latest: { version: latest } };
    else result = {
      state: 'available', latest: { version: latest, publishedAt: release.published_at || null, notes: String(release.body || '').slice(0, 4000) },
      asset: { name: asset.name, size: asset.size, verifiable: !!asset.sha256 }
    };
  } catch (error) {
    result = { state: 'error', error: error.message };
  }
  result.checkedAt = new Date().toISOString();
  result.installedVersion = mine;
  try { setConfig('windows_update_status', JSON.stringify(result)); } catch (_) { /* no database in tests */ }
  return result;
}

/** What Settings shows: the saved check, unless this version has since caught up. */
function status() {
  const saved = lastStatus();
  if (saved && saved.state === 'available' && !isNewer(saved.latest && saved.latest.version, appVersion())) return { ...saved, state: 'up-to-date' };
  return saved;
}

function progress() { return applying ? { ...applying } : null; }

/**
 * Download the newest installer, verify it, and start it. Resolves once the installer is running;
 * it ends this process (the service is stopped by the installer), so the page reconnects afterwards.
 */
async function apply() {
  if (!isWindowsInstall()) throw Object.assign(new Error('This is not the Windows installer build.'), { status: 400 });
  if (applying) throw Object.assign(new Error('An update is already being installed.'), { status: 409 });
  applying = { step: 'checking', bytes: 0, total: null, startedAt: new Date().toISOString() };
  try {
    const res = await fetcher(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Epilykos-update-check' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    const asset = pickAsset(release);
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (!asset || !isNewer(version, appVersion())) throw Object.assign(new Error('This is already the newest version.'), { status: 400 });
    if (!asset.sha256) throw new Error('GitHub did not publish a checksum for this installer, so it was not installed.');

    applying.step = 'downloading'; applying.total = asset.size;
    const file = path.join(fs.mkdtempSync(path.join(tmpDir(), 'epilykos-update-')), asset.name);
    const download = await fetcher(asset.url, { headers: { 'User-Agent': 'Epilykos-update-check' }, signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!download.ok || !download.body) throw new Error(`The download failed (${download.status})`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const meter = async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length; applying.bytes = bytes;
        if (bytes > MAX_BYTES) throw new Error('The installer is larger than expected.');
        hash.update(chunk); yield chunk;
      }
    };
    await pipeline(Readable.fromWeb(download.body), meter, fs.createWriteStream(file, { mode: 0o600 }));

    applying.step = 'verifying';
    if (hash.digest('hex') !== asset.sha256) { try { fs.unlinkSync(file); } catch (_) {} throw new Error('The downloaded installer did not match its checksum, so it was not installed.'); }

    applying.step = 'installing';
    logger.warn(`[updates] Starting the Epilykos ${version} installer`);
    // The installer stops this service, which would end a child of this process with it. A one-shot scheduled
    // task runs it under the Task Scheduler instead (as SYSTEM), outside this process tree.
    const command = `"${file}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RESTARTAPPLICATIONS`;
    await schtasks(['/Create', '/TN', 'EpilykosUpdate', '/TR', command, '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F']);
    await schtasks(['/Run', '/TN', 'EpilykosUpdate']);
    return { state: 'applying', message: `Installing Epilykos ${version}. The dashboard is away for a minute.`, version };
  } catch (error) {
    applying = null;
    throw error;
  }
}

module.exports = { isWindowsInstall, parseVersion, isNewer, pickAsset, check, status, progress, apply, setForTests, DOWNLOAD_PREFIX };
