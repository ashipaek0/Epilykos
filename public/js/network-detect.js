/**
 * Epilykos Network Detector
 *
 * Responsibilities:
 * 1. Load network URLs from server config (via /api/network-config)
 * 2. Send URLs to Service Worker for routing
 * 3. On settings page: provide config to the SW
 * 4. On dashboard: show network indicator if on remote but local reachable
 */

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
  console.log('[Network] Sent config to SW:', { localURL, remoteURL });
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

// ── Network indicator on dashboard ───────────────────────────────────
async function checkLocalReachable(localURL) {
  if (!localURL) return false;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${localURL}/manifest.json`, {
      signal: controller.signal,
      mode: 'no-cors' // Avoid CORS issues
    });
    return true;
  } catch {
    return false;
  }
}

async function showNetworkBanner(localURL) {
  const currentHost = window.location.host;
  const localHost = new URL(localURL).host;
  
  // Only show if we're on remote but local is reachable
  if (currentHost === localHost) return;
  
  const reachable = await checkLocalReachable(localURL);
  if (!reachable) return;
  
  // Don't show if already dismissed
  if (sessionStorage.getItem('epilykos-banner-dismissed')) return;
  
  const banner = document.createElement('div');
  banner.id = 'network-banner';
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    background: #16a34a; color: white; padding: 0.6rem 1rem;
    display: flex; align-items: center; justify-content: center;
    gap: 0.75rem; font-size: 0.9rem; font-weight: 500;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;
  banner.innerHTML = `
    <span>🏠 You're on your home network</span>
    <a href="${localURL}" style="
      color: white; background: rgba(255,255,255,0.2);
      padding: 0.3rem 0.75rem; border-radius: 1rem;
      text-decoration: none; font-weight: 600;
    ">Switch to local</a>
    <button onclick="this.parentElement.remove();sessionStorage.setItem('epilykos-banner-dismissed','1')" style="
      background: none; border: none; color: white; cursor: pointer;
      font-size: 1.2rem; padding: 0 0.25rem;
    ">✕</button>
  `;
  document.body.prepend(banner);
}

// ── Init ──────────────────────────────────────────────────────────────
async function initNetworkDetect() {
  const config = await loadNetworkConfig();
  
  // On dashboard, check if we should show the banner
  if (config?.localURL && !window.location.pathname.startsWith('/login')) {
    showNetworkBanner(config.localURL);
  }

  // Re-send config when settings are saved
  document.addEventListener('stg-save-complete', () => {
    loadNetworkConfig();
  });
}

// ── Public API ───────────────────────────────────────────────────────
window.EpilykosNetwork = {
  init: initNetworkDetect,
  sendConfig: sendConfigToSW,
  loadConfig: loadNetworkConfig
};

// Auto-init on non-login pages
if (!window.location.pathname.startsWith('/login')) {
  initNetworkDetect();
}
