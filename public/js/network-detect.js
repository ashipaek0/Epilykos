/**
 * Epilykos Network Detector — TRUE auto-failover base-URL resolver (Phase 4, Slice 2)
 *
 * Responsibilities:
 * 1. Load network URLs from server config (via /api/network-config)
 * 2. Send URLs to Service Worker for routing (kept — SW uses them for offline cache / background sync)
 * 3. Resolve the active base URL (local when reachable, else remote)
 * 4. D-4A: origin-redirect the SPA to the reachable base once (reads stay relative/same-origin, no CORS)
 * 5. Periodic re-check with hysteresis (N consecutive failures) + backoff when both bases are down
 *
 * Design notes (from the locked decisions):
 *   D-4A  -> origin-switch on failover, single reload
 *   D-4B  -> image-ping probes (no CORS needed, bypasses mixed-content)
 *   D-4C  -> this module is the SOLE owner of base selection
 *   D-4D  -> (retired) the Auto/Local/Remote control and its saved mode
 *   D-4E  -> read-only public GETs only; authenticated POSTs are never touched
 */

// ── Constants ─────────────────────────────────────────────────────────
const NET_MODE_KEY = 'epilykos-network-mode';
const BASE_CHECK_MS = 12000;          // ~12s periodic re-check
const HYSTERESIS_THRESHOLD = 3;       // consecutive failing probes before we switch/failover
const OFFLINE_BACKOFF_MS = 30000;     // back off to 30s when both bases are down

// ── State ─────────────────────────────────────────────────────────────
let cachedConfig = null;      // last {localURL, remoteURL} from /api/network-config
let activeBase = null;        // last known active base URL (exposed via getActiveBase)
let checkTimer = null;        // setTimeout handle for the periodic re-check
let currentInterval = BASE_CHECK_MS;
let consecutiveDown = 0;      // consecutive unreachable probes for the CURRENT origin
let offlineFlag = false;      // both bases down -> offline state + backoff

// ── Mode helpers ──────────────────────────────────────────────────────
// The Auto/Local/Remote control is gone from the home page, so a pin saved by
// an earlier version is dropped: a box could otherwise stay stuck on one base.
function dropSavedMode() {
  try { localStorage.removeItem(NET_MODE_KEY); } catch (e) { /* storage blocked */ }
}

function urlOrigin(u) {
  if (!u) return null;
  try { return new URL(u).origin; } catch (e) { return null; }
}

// ── Send config to SW ────────────────────────────────────────────────
function sendConfigToSW(localURL, remoteURL) {
  if (!navigator.serviceWorker?.controller) {
    // SW not ready yet — retry when it is
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(reg => {
        reg.active?.postMessage({ type: 'network-config', localURL, remoteURL });
      });
    }
    return;
  }
  navigator.serviceWorker.controller.postMessage({
    type: 'network-config',
    localURL,
    remoteURL
  });
  console.debug('[Network] Sent config to SW:', { localURL, remoteURL });
}

// ── Load from server ─────────────────────────────────────────────────
async function loadNetworkConfig() {
  try {
    const res = await fetch('/api/network-config');
    if (res.ok) {
      const config = await res.json();
      if (config.localURL || config.remoteURL) {
        sendConfigToSW(config.localURL || '', config.remoteURL || '');
        return config;
      }
    }
  } catch (e) {
    // Not logged in or endpoint not available — that's fine
  }
  return null;
}

// ── Probe a base (image ping) ─────────────────────────────────────────
// Uses an image ping instead of fetch — images bypass mixed-content
// blocking, so this works even from HTTPS pages, and cross-origin image
// loads need no CORS (D-4B). Adapted to probe ANY base.
function checkLocalReachable(baseURL) {
  if (!baseURL) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => { img.src = ''; resolve(false); }, 2000);
    img.onload = () => { clearTimeout(timeout); resolve(true); };
    img.onerror = () => { clearTimeout(timeout); resolve(false); };
    // Any small static asset — 404/200 doesn't matter, we just need the
    // TCP connection to succeed.
    img.src = `${baseURL}/icons/icon-192.png?${Date.now()}`;
  });
}

// ── Base-URL resolver (D-4C: sole owner of base selection) ────────────
// Given {localURL, remoteURL}, pick the active base: local when reachable, else remote.
async function resolveBase(config) {
  const localURL = config?.localURL;
  const remoteURL = config?.remoteURL;

  // Nothing configured.
  if (!localURL && !remoteURL) {
    return { active: null, single: true, localReachable: false, remoteReachable: false };
  }

  // Only one base configured -> fixed base, no failover.
  if (!localURL || !remoteURL) {
    const active = localURL || remoteURL;
    return {
      active,
      single: true,
      localReachable: Boolean(localURL),
      remoteReachable: Boolean(remoteURL)
    };
  }

  // Both configured -> probe both.
  let localReachable = false;
  let remoteReachable = false;
  try {
    [localReachable, remoteReachable] = await Promise.all([
      checkLocalReachable(localURL),
      checkLocalReachable(remoteURL)
    ]);
  } catch (e) {
    localReachable = remoteReachable = false;
  }

  const active = localReachable ? localURL : remoteURL;

  return { active, single: false, localReachable, remoteReachable };
}

// ── D-4A origin-switch ────────────────────────────────────────────────
// If the resolved active base differs from the page's current origin (and the
// target is reachable), redirect the SPA to it once (a single reload on switch).
async function ensureCorrectOrigin(config) {
  const resolved = await resolveBase(config);
  const currentOrigin = window.location.origin;
  const activeOrigin = resolved.active ? urlOrigin(resolved.active) : null;

  if (!resolved.active || !activeOrigin) return null; // single-base / nothing to switch

  const activeReachable = resolved.active === config.localURL
    ? resolved.localReachable
    : resolved.active === config.remoteURL ? resolved.remoteReachable : true;

  if (currentOrigin !== activeOrigin && activeReachable) {
    activeBase = resolved.active;
    // D-4A: one reload on origin switch. Page navigates -> stop.
    window.location.href = resolved.active;
    return null;
  }

  activeBase = resolved.active;
  return resolved;
}

// Both bases down: back off (no pill any more; the dashboard shows its own state).
function setOffline(flag) { offlineFlag = flag; }

// ── Periodic re-check with hysteresis + backoff ───────────────────────
// handleTick decides failover.
async function handleTick(resolved, config) {
  const currentOrigin = window.location.origin;
  const localOrigin = urlOrigin(config.localURL);
  const remoteOrigin = urlOrigin(config.remoteURL);

  // Is the origin the page is CURRENTLY served from reachable?
  let currentReachable = false;
  if (currentOrigin === localOrigin) currentReachable = resolved.localReachable;
  else if (currentOrigin === remoteOrigin) currentReachable = resolved.remoteReachable;

  const desiredBase = resolved.active;
  const desiredOrigin = desiredBase ? urlOrigin(desiredBase) : null;
  const desiredReachable = desiredBase === config.localURL
    ? resolved.localReachable
    : desiredBase === config.remoteURL ? resolved.remoteReachable : false;

  if (currentReachable) {
    // Healthy. Reset failure counter + backoff.
    consecutiveDown = 0;
    currentInterval = BASE_CHECK_MS;
    setOffline(false);

    // Healthy: stay put (no bouncing back to the local base while both are up).
    return;
  }

  // Current origin is unreachable (or unknown). Count consecutive failures.
  consecutiveDown++;
  if (consecutiveDown < HYSTERESIS_THRESHOLD) return;

  // Hysteresis satisfied -> fail over.
  if (desiredReachable && desiredOrigin && desiredOrigin !== currentOrigin) {
    activeBase = desiredBase;
    window.location.href = desiredBase;
    return;
  }

  // Desired base down — try the other reachable base as a last resort.
  const otherBase = desiredBase === config.localURL ? config.remoteURL : config.localURL;
  const otherReachable = otherBase === config.localURL ? resolved.localReachable : resolved.remoteReachable;
  const otherOrigin = urlOrigin(otherBase);
  if (otherReachable && otherOrigin && otherOrigin !== currentOrigin) {
    activeBase = otherBase;
    window.location.href = otherBase;
    return;
  }

  // Both bases down -> offline state + back off (no redirect, no crash).
  setOffline(true);
  currentInterval = OFFLINE_BACKOFF_MS;
}

async function runCheck() {
  try {
    const config = cachedConfig;
    if (config?.localURL && config?.remoteURL) {
      const resolved = await resolveBase(config);
      activeBase = resolved.active;
      await handleTick(resolved, config);
    }
  } catch (e) {
    // Never throw unhandled from a background timer.
    console.error('[Network] Periodic check failed:', e);
  } finally {
    checkTimer = setTimeout(runCheck, currentInterval);
  }
}

function startRecheck() {
  if (checkTimer) clearTimeout(checkTimer);
  currentInterval = BASE_CHECK_MS;
  consecutiveDown = 0;
  setOffline(false);
  runCheck();
}

function stopRecheck() {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = null;
}

// ── Init ──────────────────────────────────────────────────────────────
async function initNetworkDetect() {
  dropSavedMode();
  const config = await loadNetworkConfig();
  cachedConfig = config;

  // No config / load failed -> nothing to do (no indicator for a single base).
  if (!config || !config.localURL || !config.remoteURL) {
    activeBase = (config?.localURL || config?.remoteURL) || null;
    return;
  }

  // Both bases configured -> enable TRUE failover.
  const resolved = await ensureCorrectOrigin(config);
  if (!resolved) return; // redirected (page reloading) -> stop

  startRecheck();

  // Re-load / re-evaluate after settings are saved.
  document.addEventListener('stg-save-complete', () => {
    if (config.localURL && config.remoteURL) {
      loadNetworkConfig().then(cfg => {
        if (cfg?.localURL && cfg?.remoteURL) {
          cachedConfig = cfg;
          stopRecheck();
          ensureCorrectOrigin(cfg).then(r => {
            if (!r) return; // redirected
            startRecheck();
          });
        }
      });
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────
window.EpilykosNetwork = {
  init: initNetworkDetect,
  sendConfig: sendConfigToSW,
  loadConfig: loadNetworkConfig,
  getActiveBase: () => activeBase
};

// Auto-init on non-login pages
if (!window.location.pathname.startsWith('/login')) {
  initNetworkDetect();
}
