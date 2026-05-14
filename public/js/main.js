import { initTheme, toggleTheme } from './theme.js';
import { loadDashboardConfig } from './dashboard.js';
import { updateWithState } from './updater.js';

let ws = null;
let reconnectTimer = null;

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'dashboard-state') {
        console.log('Received WebSocket update');
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

// Show a loading indicator
const container = document.getElementById('dashboard-container');
if (container) {
  container.innerHTML = '<div style="text-align:center; padding:2rem;">Loading dashboard...</div>';
}

initTheme();

try {
  await loadDashboardConfig();
  console.log('Dashboard config loaded successfully');
} catch (err) {
  console.error('Failed to load dashboard config:', err);
  if (container) {
    container.innerHTML = '<div class="error" style="padding:2rem;text-align:center;color:#ef4444;">Failed to load dashboard configuration. Please check the server logs and ensure the server is running.</div>';
  }
}

connectWebSocket();

// Fallback polling every 60 seconds (in case WebSocket fails)
setInterval(async () => {
  const { updateAllComponents } = await import('./updater.js');
  updateAllComponents();
  console.log('Fallback poll executed');
}, 60000);

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
