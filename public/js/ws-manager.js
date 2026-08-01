/**
 * Epilykos WebSocket Manager
 *
 * Wraps the raw WebSocket with:
 * - IndexedDB caching (every state update persisted)
 * - Auto-reconnect with exponential backoff
 * - Background/foreground handling
 * - SW background-refresh message handling
 * - Instant cache load on app start
 */

const DB_NAME = 'epilykos-cache';
const DB_VERSION = 1;
const STORE_NAME = 'state';
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]; // exponential-ish
const MAX_RECONNECT_ATTEMPTS = 30; // stop retrying after 30 attempts (~15 min)

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let onStateUpdate = null; // callback: (state) => void
let onConnect = null;     // callback: () => void
let db = null;

// ── IndexedDB setup ──────────────────────────────────────────────────
async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function cacheState(state) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(state, 'latest');
  } catch (e) {
    console.warn('[WSManager] Cache write failed:', e.message);
  }
}

async function loadCachedState() {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get('latest');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ── Connect ──────────────────────────────────────────────────────────
export function connectWebSocket({ onMessage, onOpen }) {
  onStateUpdate = onMessage;
  onConnect = onOpen;
  reconnectAttempt = 0;
  doConnect();
}

function getWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function doConnect() {
  if (ws) {
    ws.onclose = null; // prevent reconnect from old socket
    ws.close();
  }

  const wsUrl = getWsUrl();
  console.debug('[WSManager] Connecting to', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.debug('[WSManager] Connected');
    reconnectAttempt = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (onConnect) onConnect();
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'dashboard-state' && message.data) {
        // Cache every state update
        await cacheState(message.data);
        if (onStateUpdate) onStateUpdate(message.data);
      }
    } catch (err) {
      console.error('[WSManager] Message parse error:', err);
    }
  };

  ws.onerror = (err) => {
    console.error('[WSManager] Error:', err);
  };

  ws.onclose = () => {
    console.debug('[WSManager] Disconnected');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[WSManager] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
    return;
  }
  const baseDelay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  const jitter = Math.floor(Math.random() * baseDelay * 0.3); // ±30% jitter
  const delay = baseDelay + jitter;
  console.debug(`[WSManager] Reconnecting in ${delay}ms (attempt ${reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS})`);
  reconnectTimer = setTimeout(() => {
    reconnectAttempt++;
    doConnect();
  }, delay);
}

// ── Load cached state on startup ─────────────────────────────────────
export async function loadInitialState() {
  const cached = await loadCachedState();
  if (cached) {
    console.debug('[WSManager] Loaded cached state from IndexedDB');
    return cached;
  }
  return null;
}

// ── Background sync handler ──────────────────────────────────────────
export function setupBackgroundSync() {
  // Listen for background refresh data from service worker
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'background-refresh' && onStateUpdate) {
      console.debug('[WSManager] Received background refresh from SW');
      onStateUpdate(event.data.data);
    }
  });

  // Handle visibility change — reconnect WS when app comes to foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      console.debug('[WSManager] App resumed — reconnecting WS');
      reconnectAttempt = 0;
      doConnect();
    }
  });

  // Register periodic background sync if supported
  if (self.registration && 'periodicSync' in self.registration) {
    self.registration.periodicSync.register('refresh-metrics', {
      minInterval: 1 * 60 * 1000 // 1 minute
    }).then(() => {
      console.debug('[WSManager] Periodic background sync registered');
    }).catch(err => {
      console.warn('[WSManager] Periodic sync not available:', err.message);
    });
  }
}
