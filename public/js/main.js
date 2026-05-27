import { initTheme, toggleTheme } from './theme.js';
import { loadDashboardConfig } from './dashboard.js';
import { updateWithState } from './updater.js';

let ws = null;
let reconnectTimer = null;
let configLoadAttempts = 0;
const MAX_CONFIG_ATTEMPTS = 3;

async function loadConfigWithRetry() {
  try {
    await loadDashboardConfig();
    console.log('Dashboard config loaded successfully');
    // Proceed with WebSocket and polling
    connectWebSocket();
    setInterval(async () => {
      const { updateAllComponents } = await import('./updater.js');
      updateAllComponents();
      console.log('Fallback poll executed');
    }, 60000);
  } catch (err) {
    console.error(`Failed to load dashboard config (attempt ${configLoadAttempts + 1}/${MAX_CONFIG_ATTEMPTS}):`, err);
    configLoadAttempts++;
    if (configLoadAttempts < MAX_CONFIG_ATTEMPTS) {
      // Retry after 2 seconds
      setTimeout(loadConfigWithRetry, 2000);
    } else {
      const container = document.getElementById('dashboard-container');
      if (container) {
        container.innerHTML = '<div class="error" style="padding:2rem;text-align:center;color:#ef4444;">Unable to load dashboard configuration after multiple attempts. Please check server logs.</div>';
      }
    }
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    // Immediately fetch initial state since WebSocket push may take up to 30s
    import('./updater.js').then(m => m.updateAllComponents());
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'dashboard-state') {
        updateWithState(message.data);
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected, will reconnect');
    reconnectTimer = setTimeout(connectWebSocket, 5000);
  };
}

// Show loading indicator
const container = document.getElementById('dashboard-container');
if (container) {
  container.innerHTML = '<div style="text-align:center; padding:2rem;">Loading dashboard...</div>';
}

initTheme();
loadConfigWithRetry();
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
