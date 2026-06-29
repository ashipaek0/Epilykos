import { initTheme, toggleTheme } from './theme.js';
import { loadDashboardConfig } from './dashboard.js';
import { updateWithState } from './updater.js';
import { connectWebSocket, loadInitialState, setupBackgroundSync } from './ws-manager.js';

let configLoadAttempts = 0;
const MAX_CONFIG_ATTEMPTS = 3;

async function loadConfigWithRetry() {
  try {
    await loadDashboardConfig();
    console.log('Dashboard config loaded successfully');

    // 1. Load cached state instantly (from IndexedDB) — zero wait
    const cached = await loadInitialState();
    if (cached) {
      console.log('Applying cached state from IndexedDB');
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
    }, 60000);
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
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
