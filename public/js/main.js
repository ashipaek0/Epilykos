import { initTheme, toggleTheme } from './theme.js';
import { loadDashboardConfig } from './dashboard.js';
import { updateWithState } from './updater.js';
import { connectWebSocket, loadInitialState, setupBackgroundSync } from './ws-manager.js';

// ── PWA Install prompt handler ────────────────────────────────────────
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent the browser's default mini-infobar
  e.preventDefault();
  // Stash the event so it can be triggered later
  deferredInstallPrompt = e;

  // Show a custom install button in the top bar
  const btn = document.createElement('button');
  btn.id = 'pwa-install-btn';
  btn.textContent = '⬇ Install';
  btn.style.cssText = `
    background: #f59e0b; color: white; border: none;
    border-radius: 0.5rem; padding: 0.4rem 0.75rem;
    font-size: 0.8rem; font-weight: 600; cursor: pointer;
    white-space: nowrap;
  `;
  btn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.debug(`[PWA] Install prompt: ${outcome}`);
    deferredInstallPrompt = null;
    btn.remove();
  });

  // Insert next to theme toggle
  const toggle = document.getElementById('theme-toggle');
  if (toggle?.parentNode) {
    toggle.parentNode.insertBefore(btn, toggle);
  }
});

window.addEventListener('appinstalled', () => {
  console.debug('[PWA] App installed successfully');
  deferredInstallPrompt = null;
  document.getElementById('pwa-install-btn')?.remove();
});

let configLoadAttempts = 0;
const MAX_CONFIG_ATTEMPTS = 3;

async function loadConfigWithRetry() {
  try {
    await loadDashboardConfig();
    console.debug('Dashboard config loaded successfully');

    // 1. Load cached state instantly (from IndexedDB) — zero wait
    const cached = await loadInitialState();
    if (cached) {
      console.debug('Applying cached state from IndexedDB');
      updateWithState(cached);
    }

    // 2. Connect WebSocket (with auto-reconnect and background handling)
    connectWebSocket({
      onMessage: (state) => updateWithState(state),
      onOpen: async () => {
        // Fetch fresh API data on connect
        const { updateAllComponents } = await import('./updater.js');
        updateAllComponents();
      }
    });

    // 3. Setup background sync (SW periodic + visibility change)
    setupBackgroundSync();

    // 4. Fallback poll every 60s
    setInterval(async () => {
      const { updateAllComponents } = await import('./updater.js');
      updateAllComponents();
    }, 30000);
  } catch (err) {
    console.error(`Failed to load dashboard config (attempt ${configLoadAttempts + 1}/${MAX_CONFIG_ATTEMPTS}):`, err);
    configLoadAttempts++;
    if (configLoadAttempts < MAX_CONFIG_ATTEMPTS) {
      setTimeout(loadConfigWithRetry, 2000);
    } else {
      const container = document.getElementById('dashboard-container');
      if (container) {
        container.innerHTML = '<div class="error" style="padding:2rem;text-align:center;color:#ef4444;">Unable to load dashboard configuration after multiple attempts. Please check server logs.</div>';
      }
    }
  }
}

// Show loading indicator
const container = document.getElementById('dashboard-container');
if (container) {
  container.innerHTML = '<div style="text-align:center; padding:2rem;">Loading dashboard...</div>';
}

initTheme();
loadConfigWithRetry();
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
