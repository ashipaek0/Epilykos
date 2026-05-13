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

initTheme();
await loadDashboardConfig();
connectWebSocket();

// Fallback polling every 60 seconds (only if WebSocket is not delivering, but it's harmless)
setInterval(async () => {
  const { updateAllComponents } = await import('./updater.js');
  updateAllComponents();
}, 60000);

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
