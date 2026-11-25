/**
 * Epilykos Energy Dashboard — Express Server
 *
 * Core responsibilities:
 * - Serves static frontend files (HTML, CSS, JS modules)
 * - Provides REST API for dashboard state, metrics, config, and settings
 * - Manages WebSocket connections for real-time state push (30s interval)
 * - Orchestrates polling: HA, MQTT, Modbus, External REST, BMS bridge
 * - Session-based auth for settings/editor with CSRF protection
 * - Database backup/restore, layout import/export
 *
 * @module server
 */
require('dotenv').config({ quiet: true });
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const morgan = require('morgan');
const WebSocket = require('ws');
const http = require('http');
const { logger } = require('./modules/logger');
const databaseWork = require('./modules/databaseWork');
const { PollingManager } = require('./services/PollingManager');
const { createLivePush } = require('./modules/livePush');
const { planBroadcast, MAX_MESSAGE_BYTES } = require('./modules/broadcastPlan');
const { timeZoneName } = require('./modules/localTime');
const { initializeDatabase, getConfig, setConfig, getDb, startMetricAutoFlush, stopMetricAutoFlush, flushSync, flushMetrics, onMetricsFlushed, migrateSecretsToEncrypted, resolveStoredSecret } = require('./modules/database');

/**
 * Compute delta between current and previous state objects.
 * Pure recursive function: compares objects/arrays by reference equality.
 * - Objects: only include keys with changed values (recursive).
 * - Arrays: compare by length first; if length differs, include entire array.
 *   If length same, compare items by index; changed item → include whole index.
 * - Primitives: strict equality (===).
 * Returns empty object {} if identical; otherwise minimal delta object.
 * @param {any} current - current state
 * @param {any} previous - previous state
 * @returns {object} delta object
 */
function computeDelta(current, previous) {
  if (current === previous) return {};
  if (current === null || previous === null) return current;
  if (typeof current !== 'object' || typeof previous !== 'object') return current;
  if (Array.isArray(current) !== Array.isArray(previous)) return current;
  
  if (Array.isArray(current)) {
    // Arrays: whole-array on any length/item difference (simple, correct)
    if (current.length !== previous.length) return current;
    for (let i = 0; i < current.length; i++) {
      const c = current[i];
      const p = previous[i];
      if (c === p) continue;
      if (c !== null && p !== null && typeof c === 'object' && typeof p === 'object') {
        const sub = computeDelta(c, p);
        const empty = (typeof sub === 'object' && sub !== null && !Array.isArray(sub) && Object.keys(sub).length === 0);
        if (!empty) return current;
      } else {
        // Primitives (or null) differ by strict !== → whole array
        return current;
      }
    }
    return {};
  }

  // Object case: primitives → strict ===; plain objects → recurse (sub-delta
  // only when non-empty); arrays → whole-array on any difference;
  // deleted keys → null; added keys → value.
  const delta = {};
  let hasChanges = false;
  for (const key of Object.keys(current)) {
    if (!(key in previous)) {
      delta[key] = current[key];
      hasChanges = true;
      continue;
    }
    const c = current[key];
    const p = previous[key];
    if (c === p) continue;
    const cIsObj = (c !== null && typeof c === 'object' && !Array.isArray(c));
    const pIsObj = (p !== null && typeof p === 'object' && !Array.isArray(p));
    if (cIsObj && pIsObj) {
      const subDelta = computeDelta(c, p);
      if (Object.keys(subDelta).length > 0) {
        delta[key] = subDelta;
        hasChanges = true;
      }
    } else if (Array.isArray(c) && Array.isArray(p)) {
      const arrDelta = computeDelta(c, p);
      const empty = (typeof arrDelta === 'object' && arrDelta !== null && !Array.isArray(arrDelta) && Object.keys(arrDelta).length === 0);
      if (!empty) {
        delta[key] = c;
        hasChanges = true;
      }
    } else if (c !== p) {
      // Primitives, null, or type-mismatched values differ → assign value
      delta[key] = c;
      hasChanges = true;
    }
  }
  for (const key of Object.keys(previous)) {
    if (!(key in current)) {
      // Key deleted - represent as null to signal removal
      delta[key] = null;
      hasChanges = true;
    }
  }
  return hasChanges ? delta : {};
}

// Export for tests
module.exports.computeDelta = computeDelta;
const { isAuthenticated, csrfProtection } = require('./modules/sessionAuth');
const { setupMqtt, mqttClients } = require('./modules/mqtt');
const { loadProfiles } = require('./modules/modbus');
const { loadRs232Profiles, shutdownRs232, restartRs232Streaming } = require('./modules/rs232');
const { testForecast, clearForecastCache } = require('./modules/solar');
const { getCurrentMetrics, getMetricHistory } = require('./modules/metrics');
const { getDashboardConfig, saveDashboardConfig } = require('./modules/dashboard-config');
const { backupDatabase, restoreDatabase, startSnapshotScheduler, stopSnapshotScheduler, listSnapshots, restoreFromSnapshot, checkpointWal } = require('./modules/backup');
const { assertSafeFetchUrl, safeFetch } = require('./modules/utils');
const { startExternalPolling, stopExternalPolling } = require('./modules/external');
const { startBmsPolling, stopBmsPolling } = require('./modules/bms');
const { startBmsWiredPolling, stopBmsWiredPolling } = require('./modules/bmsWired');
const { startDonglePolling, stopDonglePolling } = require('./modules/dongle');
const pvoutput = require('./modules/pvoutput');
const notifications = require('./modules/notifications');
const { router: metricsRouter, buildDashboardState, sharedDashboardState } = require('./routes/metrics');
// Issue #108 (AC-1..13): dongle projections live in the pure module; the
// remaining per-family projections are route-level pure helpers below (server
// wave touches server.js only). All catalog routes are thin wrappers.
const entityCatalog = require('./modules/entityCatalog');
const { bundledProfilePath } = require('./modules/bundledProfiles');
const { updateInverterMetrics } = require('./modules/inverterSetup');
const { stringFields } = require('./modules/requestFields');

// ================= #108 catalog projections (pure) =================
// No fs / network / DB / logger. Every function below takes parsed data and
// returns catalog items, so the route handlers stay thin wrappers. Named to
// mirror the entityCatalog.js API (catEntity + per-source projections) so a
// later slice can move them into that module verbatim.
// ===================================================================

const REST_FLATTEN_DEFAULT_CAPS = Object.freeze({ maxDepth: 6, maxLeaves: 500, maxArrayItems: 100 });

function flattenJsonLeaves(doc, caps) {
  // AC-11: deterministic DFS flatten of a parsed JSON document to scalar leaves
  // {path, value, type, sample}. Caps: path ≤ maxDepth segments, ≤ maxLeaves
  // leaves (first-N), arrays expanded to maxArrayItems items then capped.
  // Objects iterate in insertion order, arrays by numeric index; only
  // number/string/boolean leaves are emitted; empty containers and non-leaf
  // values are skipped. Returns { leaves, truncated }.
  const maxDepth = caps && caps.maxDepth !== undefined ? caps.maxDepth : REST_FLATTEN_DEFAULT_CAPS.maxDepth;
  const maxLeaves = caps && caps.maxLeaves !== undefined ? caps.maxLeaves : REST_FLATTEN_DEFAULT_CAPS.maxLeaves;
  const maxArrayItems = caps && caps.maxArrayItems !== undefined ? caps.maxArrayItems : REST_FLATTEN_DEFAULT_CAPS.maxArrayItems;
  const leaves = [];
  let truncated = false;

  const kindOf = (v) => {
    if (v === null) return 'null';
    return Array.isArray(v) ? 'array' : typeof v;
  };
  const sampleOf = (value) => {
    const s = typeof value === 'string' ? value : String(value);
    return s.length > 200 ? s.slice(0, 200) : s;
  };

  function visit(value, segments) {
    if (leaves.length >= maxLeaves) { truncated = true; return; }
    const kind = kindOf(value);
    if (kind === 'number' || kind === 'string' || kind === 'boolean') {
      // Scalars are leaves when their path fits the segment budget (parents
      // refuse to descend past maxDepth).
      if (segments.length <= maxDepth) {
        leaves.push({ path: segments.join('.'), value, type: kind, sample: sampleOf(value) });
      }
      return;
    }
    if (kind === 'null') return;
    if (kind !== 'array' && kind !== 'object') return; // function/symbol/undefined etc. are not JSON — skipped silently
    const isEmpty = kind === 'array' ? value.length === 0 : Object.keys(value).length === 0;
    if (isEmpty) return; // skip empty containers
    if (segments.length >= maxDepth) { truncated = true; return; } // non-empty content beyond depth budget
    if (kind === 'array') {
      if (value.length > maxArrayItems) truncated = true;
      const n = Math.min(value.length, maxArrayItems);
      for (let i = 0; i < n; i++) visit(value[i], segments.concat(String(i)));
    } else if (kind === 'object') {
      for (const key of Object.keys(value)) visit(value[key], segments.concat(key));
    }
  }

  visit(doc, []);
  return { leaves, truncated };
}

// ================= /#108 catalog projections =================

const app = express();
app.disable('x-powered-by');   // do not announce the framework
// What to believe about X-Forwarded-For (rate limits, Secure cookie): see modules/trustProxy.js.
app.set('trust proxy', require('./modules/trustProxy').resolveTrustProxy(process.env.TRUST_PROXY));
app.use((req, res, next) => databaseWork.run(next));
const PORT = process.env.PORT || 3000;

// Health probe first: never rate-limited, never logged per request (it is
// polled every 30 s by Docker/Podman).
app.use(require('./routes/health').router);

// Global rate limiter — 2000 API requests per 15 min per IP. Pages and their
// files don't count: one dashboard load fetches ~100 scripts, styles and
// images, so counting them locked people out (a blank 429 page) after a dozen
// reloads, and everyone at once behind a reverse proxy. Login has its own limit.
const globalLimiter = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, limit: 2000, standardHeaders: 'draft-6', legacyHeaders: false, skip: req => (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/') });
app.use(globalLimiter);

// Morgan HTTP request logging (stream to winston)
// Settings → Logs polls every few seconds; logging those requests would fill the log with itself.
app.use(morgan('combined', { stream: logger.stream, skip: req => req.originalUrl.startsWith('/api/logs') }));

// Compression (gzip + brotli)
app.use(compression());

// Session secret — persist across restarts so sessions survive
const SESSION_SECRET_FILE = path.join(__dirname, 'data', 'session-secret');
let sessionSecret = process.env.SESSION_SECRET;
if (sessionSecret) {
  logger.info('Using SESSION_SECRET from environment variable');
} else {
  logger.warn('⚠️  SESSION_SECRET env var not set — using persistent file-based secret');
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      sessionSecret = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (!sessionSecret) throw new Error('Empty secret file');
    } else {
      sessionSecret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
      fs.writeFileSync(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600 });
      logger.info('Generated new session secret and saved to data/session-secret');
    }
  } catch (err) {
    logger.error('Failed to read/write session secret file, falling back to ephemeral:', err.message);
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }
}

// Session middleware. Sessions are stored in SQLite (modules/sessionStore.js)
// so they survive a restart, matching the persistent secret above.
const { createSessionStore } = require('./modules/sessionStore');
const sessionStore = createSessionStore(session);
app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  // 'auto': Secure whenever the request is HTTPS (directly or via the reverse
  // proxy — trust proxy is set above), so plain-HTTP LAN access keeps working.
  // sameSite 'lax' keeps the cookie off cross-site subrequests (CSRF defence in
  // depth next to the X-Requested-With check in csrfProtection).
  cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

// Guard every unsafe request after sessions and before any route.
app.use(csrfProtection);

// Initialize database, load profiles, start MQTT and external polling
initializeDatabase();
require('./routes/remote').init();
require('./modules/dbCheck').start();
loadProfiles(); loadRs232Profiles();
try { migrateSecretsToEncrypted(); } catch (e) { logger.warn('Secret migration failed:', e.message); }

// The same synchronous handover is used for startup, candidate health and
// rollback. Local initialization must succeed before old files are discarded.
const restoreLifecycle = {
  pause() {
    stopExternalPolling(); stopBmsPolling(); stopBmsWiredPolling(); stopDonglePolling();
    stopMetricAutoFlush(); pvoutput.stop(); notifications.stop(); require('./modules/automations').stop();
    require('./modules/updates').stop();
    shutdownRs232().catch(e => logger.warn('RS232 pause: ' + e.message));
    require('./modules/combinedMetrics').flushPartDays();
  },
  resume() {
    sessionStore._db();
    require('./modules/metricSanity').reloadState();
    clearForecastCache();
    require('./modules/circuitBreaker').resetAll();
    require('./routes/logs').init();
    restartRs232Streaming();
    updateInverterMetrics();
    startExternalPolling(); startBmsPolling(); startBmsWiredPolling(); startDonglePolling();
    startMetricAutoFlush(); pvoutput.start(); notifications.init(); require('./modules/automations').start();
    require('./modules/updates').start();
    require('./routes/health').checkHealth();
  }
};
databaseWork.run(() => { setupMqtt(); restoreLifecycle.resume(); require('./modules/haDiscoveryService').start(); });
const restoreUploads = require('./modules/restoreUploads').createRestoreUploadManager({
  lifecycle: restoreLifecycle,
  captureSession: sid => sessionStore.captureForRestore(sid),
  restoreSession: record => sessionStore.restoreCaptured(record),
  onFatal(error) {
    logger.error('Restore requires supervisor recovery: ' + error.message);
    const timer = setTimeout(() => process.exit(1), 1000); timer.unref();
  }
});
const stopRestoreStagingCleanup = require('./modules/restoreStaging').startRestoreStagingCleanup('./data');
startSnapshotScheduler();
// Raw readings older than 30 days become 5-minute summaries (metrics_5m,
// history_5m), which the chart and table readers use past that point.
const retention = new (require('./modules/retentionJob').RetentionManager)().start();
// A metric deleted just before a restart: finish removing its stored readings.
setTimeout(() => require('./modules/metricHistoryPurge').resume(), 30 * 1000).unref();

// Periodic WAL checkpoint — prevents unbounded WAL file growth
// Runs every hour via setInterval (TRUNCATE resets WAL to 0 bytes after full checkpoint)
const walCheckpointInterval = setInterval(() => {
  try { checkpointWal(); } catch (e) { logger.warn('Periodic WAL checkpoint failed:', e.message); }
}, 60 * 60 * 1000);

// Multer for restore and import. Uploads (a whole backup can be one) land in a folder only this
// process can read, not loose in the shared temp directory. os.tmpdir() honours TMPDIR
// (EpilykosOS points it at a tmpfs).
const uploadDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'epilykos-uploads-'));
const upload = multer({
  dest: uploadDir,
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.db') || file.originalname.endsWith('.json')) cb(null, true);
    else cb(new Error('Only .db or .json files allowed'));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Middleware
// Security headers (incl. CSP) on every response — before any page/static route.
app.use(require('./modules/securityHeaders').middleware());
// Redirect raw editor.html / settings.html to their protected routes (auth gate — issue #87)
app.get('/editor.html', (req, res) => res.redirect('/editor'));
app.get('/settings.html', (req, res) => res.redirect('/settings'));
// Signed-in pages (card showcase, device controls) and their files — every
// request under them needs a session, whatever the method or sub path.
const { mountPrivatePages, ownsPrivatePath } = require('./routes/privatePages');
mountPrivatePages(app);
// The dashboard page, with its modules listed up front (modules/pagePreload.js).
// Ahead of express.static, which would otherwise answer / with the plain file.
const { sendPage } = require('./modules/pagePreload');
app.get(['/', '/index.html'], (req, res) => sendPage(res, path.join(__dirname, 'public', 'index.html'), '/'));
// Each module page's scripts as one file (modules/pageBundles.js); signed-in
// pages' bundles are under /private/bundles/ (routes/privatePages.js).
const pageBundles = require('./modules/pageBundles');
app.get('/bundles/:file', (req, res, next) => { if (!pageBundles.serveBundle(req, res, req.path)) next(); });
pageBundles.prebuild(['/js/main.js', '/js/editor.js', '/private/js/controls.js', '/private/js/showcase.js']);
// Serve static files with 1h browser cache
// Pages, scripts and styles revalidate on every load (ETag → 304 when unchanged)
// so an image update is visible at once; icons/fonts keep the 1 h cache.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (/\.(html|js|css|json|webmanifest)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));
// The editor's grid library, from the installed package rather than a CDN
// (a slow or blocked CDN left the editor blank; its script is render-blocking).
app.use('/vendor/gridstack', express.static(path.join(__dirname, 'node_modules', 'gridstack', 'dist'), {
  maxAge: '1h', index: false,
  setHeaders(res, filePath) { if (/\.(js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache'); }
}));
// Chart.js and its date adapter, self-hosted (was a CDN) so charts work offline
// and the CSP needs no external script origin.
app.use('/vendor/chartjs', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), { maxAge: '7d', index: false }));
app.use('/vendor/chartjs-adapter-date-fns', express.static(path.join(__dirname, 'node_modules', 'chartjs-adapter-date-fns', 'dist'), { maxAge: '7d', index: false }));
app.use(express.json());
app.get('/api/csrf-token', require('./modules/csrfProtection').csrfToken);

// Normalize req.body: Express 5 leaves req.body undefined when no parser matched
// (Express 4 defaulted to {}). Restores the v4 default globally.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);

// WebSocket limits. The live state is public, but anyone on the network (or any web page
// opened on a computer that can reach this one) could otherwise hold unlimited connections
// open, each costing a state build and every later broadcast, and send huge messages.
const WS_MAX_PAYLOAD = 64 * 1024;   // clients send nothing the server reads
const WS_MAX_CLIENTS = 150;
const WS_MAX_PER_ADDRESS = 30;      // browser tabs behind one address
const WS_PING_MS = 30 * 1000;
const wsPerAddress = new Map();

/** The client's address as Express reports it (a forwarded address only from a trusted proxy). */
function wsClientAddress(req) {
  const asRequest = Object.create(app.request);
  asRequest.app = app; asRequest.headers = req.headers; asRequest.connection = req.socket; asRequest.socket = req.socket;
  return asRequest.ip || req.socket.remoteAddress || '';
}

/** A page may open the socket only from the site that served it (browsers do not apply CORS to sockets). */
function wsOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;   // not a browser: curl, scripts, other tools
  let host; try { host = new URL(origin).host; } catch (_) { return false; }
  if (host === req.headers.host) return true;
  // A trusted proxy may have rewritten Host; it reports the one the browser used.
  const forwarded = req.headers['x-forwarded-host'];
  const trusted = app.get('trust proxy fn');
  if (forwarded && typeof trusted === 'function' && trusted(req.socket.remoteAddress, 0)) return host === String(forwarded).split(',')[0].trim();
  return false;
}

const wss = new WebSocket.Server({
  server,
  maxPayload: WS_MAX_PAYLOAD,
  verifyClient: ({ req }, done) => {
    if (!wsOriginAllowed(req)) return done(false, 403, 'Forbidden');
    if (wss.clients.size >= WS_MAX_CLIENTS || (wsPerAddress.get(wsClientAddress(req)) || 0) >= WS_MAX_PER_ADDRESS) return done(false, 429, 'Too many connections');
    done(true);
  }
});

// Store connected WebSocket clients
const wsClients = new Set();

// Delta-broadcast state: last sent snapshot + consecutive-suppression counter
// (staleness guard forces a full state every 3rd cycle when nothing changed).
let lastBroadcastState = null;
let consecutiveSuppress = 0;
let broadcastTooLargeLogged = false;

/**
 * Push dashboard state to all connected WebSocket clients.
 * What is sent (the change, the whole state, or nothing) is decided in
 * modules/broadcastPlan.js.
 * @param {object} state - built by buildDashboardState()
 * @param {{live?: boolean}} [opts] live: an extra push between polling cycles; an empty
 *   delta sends nothing and does not count toward the every-third full refresh.
 */
function broadcastDashboardState(state, { live = false } = {}) {
  const plan = planBroadcast({ state, delta: computeDelta(state, lastBroadcastState), quietCycles: consecutiveSuppress, live });
  consecutiveSuppress = plan.quietCycles;
  if (plan.tooLarge) {
    // Once per episode, not every cycle; the pages fall back to fetching.
    if (!broadcastTooLargeLogged) logger.warn(`Dashboard update not sent to open pages: ${plan.tooLarge} bytes is over the ${MAX_MESSAGE_BYTES} byte limit`);
    broadcastTooLargeLogged = true;
    return;
  }
  if (!plan.message) return;
  broadcastTooLargeLogged = false;
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(plan.message, err => {
        if (err) {
          wsClients.delete(client);
          client.terminate();
        }
      });
    }
  });
  // What the pages now have: the next change is measured against it.
  try {
    lastBroadcastState = (typeof structuredClone === 'function') ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  } catch (e) {
    lastBroadcastState = JSON.parse(JSON.stringify(state));
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  ws._address = wsClientAddress(req);
  wsPerAddress.set(ws._address, (wsPerAddress.get(ws._address) || 0) + 1);
  const release = () => {
    const left = (wsPerAddress.get(ws._address) || 1) - 1;
    if (left > 0) wsPerAddress.set(ws._address, left); else wsPerAddress.delete(ws._address);
  };
  ws.once('close', release);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  wsClients.add(ws);
  logger.info(`WebSocket client connected (${wsClients.size} total)`);
  
  (async () => {
    try {
      const state = await sharedDashboardState();
      ws.send(JSON.stringify({ type: 'dashboard-state', data: state }));
    } catch (err) {
      logger.error('Error sending initial state via WebSocket:', err);
    }
  })();

  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info(`WebSocket client disconnected (${wsClients.size} remaining)`);
  });
  ws.on('error', () => {
    wsClients.delete(ws);
    ws.terminate();
  });
});

/**
 * Main 30-second polling cycle. Fetches data from all configured sources,
 * builds dashboard state, and broadcasts to WebSocket clients.
 * Runs once immediately on startup, then every 30s via setInterval.
 */
const pollingManager = new PollingManager();
pollingManager.on('metrics-ready', ({ sourceId }) => {
  if (!databaseWork.isCurrent()) return;
  logger.debug(`Poll ${sourceId} metrics ready`);
  notifications.noteSourceResult(sourceId, true);
});
pollingManager.on('device-error', ({ sourceId, error }) => {
  if (!databaseWork.isCurrent()) return;
  logger.warn(`Poll ${sourceId} failed:`, error && error.message ? error.message : error);
  notifications.noteSourceResult(sourceId, false, error);
});

let pollCycleRunning = false;
// Between polling cycles: new readings reach the open pages within seconds (modules/livePush.js).
const livePush = createLivePush({
  hasClients: () => wsClients.size > 0,
  isCurrent: () => databaseWork.isCurrent(),
  busy: () => pollCycleRunning,
  build: () => sharedDashboardState(),
  send: state => broadcastDashboardState(state, { live: true }),
  log: logger
});
onMetricsFlushed(() => livePush.request());
function pollAllSources() { return databaseWork.run(async () => {
  // A slow source (serial timeouts, unreachable hosts) can push a cycle past
  // 30s; never run two cycles concurrently against the same devices.
  if (pollCycleRunning) {
    logger.warn('Polling cycle skipped — previous cycle still running');
    return;
  }
  pollCycleRunning = true;
  const start = Date.now();
  logger.debug('Polling cycle started');
  // MQTT, external REST, BMS and dongles run on their own timers/subscriptions
  try {
    await pollingManager.runCycle();
    if (!databaseWork.isCurrent()) return;
    flushMetrics(); // same-cycle readers (grid/solar/history, broadcast) see fresh polls
    notifications.evaluateMetrics(); // metric alert rules see this cycle's values
    if (wsClients.size > 0) {
      const state = await buildDashboardState();
      if (!databaseWork.isCurrent()) return;
      broadcastDashboardState(state);
      livePush.notePush();
    }
    const elapsed = Date.now() - start;
    logger.info(`Polling cycle completed in ${elapsed}ms`);
  } catch (err) {
    logger.error('Polling error:', err);
  } finally {
    pollCycleRunning = false;
  }
}); }
pollAllSources();
const pollInterval = setInterval(pollAllSources, 30000);
// A connection whose other end vanished (a phone out of range) never sends a close: ping, and drop what does not answer.
const wsPingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  }
}, WS_PING_MS);
if (wsPingTimer.unref) wsPingTimer.unref();
// Read the all-time daily totals once now, so the first page load doesn't pay for it.
setTimeout(() => { buildDashboardState().catch(() => {}); }, 2000).unref();

// ---------- Public API (no auth) ----------
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use('/api', metricsRouter);

// ---------- Authentication & Setup routes ----------
require('./modules/twoStep').applyEnvReset();   // RESET_TWO_STEP=true (Docker's way back in)
const authRoutes = require('./routes/auth');
app.use('/api', authRoutes);
app.use('/api/two-step', isAuthenticated, require('./routes/twoStep'));

// Public page (pre-auth; setup.js gates sources behind login)
app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// "Start fresh" reset — empties ONLY device arrays + role_metrics + flag; never history/metrics/snapshots
// EpilykosOS system actions (Settings → System): restart, shut down, Wi-Fi, SSH.
app.use('/api/system', isAuthenticated, require('./routes/system'));
app.use('/api/notices', isAuthenticated, require('./routes/notices'));
app.use('/api/setup-health', isAuthenticated, require('./routes/setupHealth'));   // Settings → Health
app.use('/api/presets', isAuthenticated, require('./routes/presets'));   // ready-made dashboards for the layout editor
app.use('/api/ha-discovery', isAuthenticated, require('./routes/haDiscovery'));   // Settings → Home Assistant
app.use('/api/prepaid', require('./routes/prepaid'));   // the balance: public unless private; changes and settings: signed in

app.post('/api/wizard/reset', isAuthenticated, (req, res) => {
  for (const k of ['ha_devices', 'mqtt_devices', 'dongle_config', 'rs232_devices', 'modbus_devices', 'bms_devices', 'external_sources']) {
    setConfig(k, '[]');
  }
  setConfig('role_metrics', '{}');
  setConfig('setup_wizard_completed', '');
  res.json({ success: true });
});

/** Path of a multer upload, checked to sit in the upload directory; else null. */
function uploadedFilePath(file) {
  const root = path.resolve(uploadDir);
  const resolved = path.resolve(String((file && file.path) || ''));
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

// ---------- Protected API (session + CSRF) – no rate limit ----------
// Test/discovery routes that carry credentials (passwords, tokens, API keys)
// are POST with a JSON body, so secrets never land in URLs, access logs or
// browser history.
app.use('/api/test-forecast', isAuthenticated);
app.post('/api/test-forecast', async (req, res) => {
  const body = stringFields(req.body);
  if (body.api_key) body.api_key = resolveStoredSecret(body.api_key, ['solcast_api_key']);
  try {
    res.json(await testForecast(body));
  } catch (err) {
    logger.error('Error in test-forecast:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/role-metrics', isAuthenticated);
app.get('/api/role-metrics', (req, res) => {
  const raw = getConfig('role_metrics');
  res.json(raw ? JSON.parse(raw) : {});
});
app.post('/api/role-metrics', (req, res) => {
  const mapping = req.body;
  if (typeof mapping !== 'object' || mapping === null) return res.status(400).json({ error: 'Expected JSON object' });
  setConfig('role_metrics', JSON.stringify(mapping));
  logger.info('[role-metrics] Updated mapping:', mapping);
  res.json({ success: true });
});

// Virtual Battery (Settings > Virtual Battery): SOC from counting the inverters' battery current.
app.use('/api/battery-estimator', isAuthenticated);
function batteryEstimatorView() {
  const be = require('./modules/batteryEstimator');
  let saved = {};
  try { saved = JSON.parse(getConfig(be.CONFIG_KEY) || '{}') || {}; } catch (_) { saved = {}; }
  const chemistries = Object.fromEntries(Object.entries(be.CHEMISTRY).map(([k, { curve, ...v }]) => [k, v]));
  const suggestions = be.suggestions(), detected = be.detectNominal(suggestions);
  return { settings: saved, effective: be.settings(saved, detected), detected_nominal: detected, status: be.getStatus(), suggestions, chemistries };
}
app.get('/api/battery-estimator', (req, res) => res.json(batteryEstimatorView()));
app.post('/api/battery-estimator', (req, res) => {
  try { require('./modules/batteryEstimator').saveSettings(req.body && req.body.settings); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(batteryEstimatorView());
});
app.post('/api/battery-estimator/soc', (req, res) => {
  try { require('./modules/batteryEstimator').setSoc(req.body && req.body.soc); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(batteryEstimatorView());
});

// Combined metrics (Settings > Metrics): definitions, last-cycle status, preview.
app.use('/api/combined-metrics', isAuthenticated);
app.get('/api/combined-metrics', (req, res) => {
  const cm = require('./modules/combinedMetrics');
  res.json({ definitions: cm.loadDefinitions(), status: cm.getCombinedStatus(), functions: cm.FNS, auto_labels: cm.autoLabels() });
});
app.post('/api/combined-metrics', (req, res) => {
  const cm = require('./modules/combinedMetrics');
  const defs = Array.isArray(req.body?.definitions) ? req.body.definitions : null;
  if (!defs || defs.length > 100) return res.status(400).json({ error: 'Expected up to 100 definitions.' });
  const clean = [];
  for (const raw of defs) {
    const def = {
      id: typeof raw.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(raw.id) ? raw.id : `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: String(raw.name || '').trim(), unit: String(raw.unit || '').trim().slice(0, 12), enabled: raw.enabled !== false,
      fn: raw.fn, inputs: (Array.isArray(raw.inputs) ? raw.inputs : []).map(x => String(x || '').trim()).filter(Boolean)
    };
    for (const k of ['weights', 'factor', 'offset', 'input_unit', 'start', 'stale_seconds', 'missing', 'note', 'when', 'on_at', 'off_at', 'daily', 'days', 'include_today']) if (raw[k] !== undefined && raw[k] !== '') def[k] = raw[k];
    if (def.weights) def.weights = def.weights.map(Number);
    for (const k of ['factor', 'offset', 'start', 'stale_seconds', 'on_at', 'off_at']) if (def[k] !== undefined) def[k] = Number(def[k]);
    if (def.days !== undefined) def.days = Number(def.days);   // average per day: the last N days (empty = every day on record)
    if (typeof def.note === 'string') def.note = def.note.slice(0, 200);
    // Names shown for the inputs on cards that list the parts: { input: label }, only for inputs in use.
    if (raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)) {
      const labels = {};
      for (const input of def.inputs) { const l = typeof raw.labels[input] === 'string' ? raw.labels[input].trim().slice(0, 40) : ''; if (l) labels[input] = l; }
      if (Object.keys(labels).length) def.labels = labels;
    }
    const errors = cm.validateDefinition(def, clean);
    if (errors.length) return res.status(400).json({ error: `${def.name || 'A combined metric'}: ${errors[0]}`, errors });
    clean.push(def);
  }
  const { cyclic } = cm.orderDefinitions(clean);
  if (cyclic.length) return res.status(400).json({ error: `These combined metrics use each other in a loop: ${cyclic.join(', ')}.` });
  setConfig(cm.CONFIG_KEY, JSON.stringify(clean));
  try { cm.pruneState(clean); } catch (err) { logger.warn('[combined] could not tidy state:', err.message); }
  // List each combined metric with its unit, so pickers and the data-spike guard know it.
  try {
    const list = JSON.parse(getConfig('user_metrics') || '[]');
    let changed = false;
    for (const d of clean) {
      const row = list.find(m => m && m.name === d.name);
      if (!row) { list.push({ name: d.name, unit: d.unit, createdAt: Date.now(), combined: true }); changed = true; }
      else if (d.unit && row.unit !== d.unit) { row.unit = d.unit; changed = true; }
    }
    if (changed) setConfig('user_metrics', JSON.stringify(list));
  } catch (err) { logger.warn('[combined] could not list metrics:', err.message); }
  logger.info(`[combined] saved ${clean.length} combined metrics`);
  res.json({ success: true, definitions: clean });
});
app.post('/api/combined-metrics/preview', (req, res) => {
  const cm = require('./modules/combinedMetrics');
  const def = req.body || {};
  const errors = cm.validateDefinition(def);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const { flushMetrics } = require('./modules/database');
  flushMetrics();
  const stmt = getDb().prepare('SELECT value, timestamp FROM latest_metrics WHERE metric = ?'), now = Math.floor(Date.now() / 1000);
  const inputs = def.inputs.map(name => {
    const row = stmt.get(String(name).trim());
    const ts = row ? (Number(row.timestamp) > 1e12 ? Math.floor(row.timestamp / 1000) : Number(row.timestamp)) : null;
    return { name, value: row ? row.value : null, age: ts == null ? null : now - ts };
  });
  const result = cm.evaluate(def, name => { const r = stmt.get(String(name).trim()); if (!r || r.value == null) return null; return { value: Number(r.value), timestamp: Number(r.timestamp) > 1e12 ? Math.floor(r.timestamp / 1000) : Number(r.timestamp) }; }, null, now);
  const energy = ['energy_today', 'energy_total', 'counter_today'].includes(def.fn);
  res.json({ inputs, value: result.skip ? null : result.value, skip: result.skip || null, note: energy ? 'Energy and daily counters start counting once saved.' : def.fn === 'threshold' ? 'Between the two limits it keeps its last state, and starts Off.' : result.note || null });
});

// Home Assistant and MQTT: entity lists and actions, test connections, topic discovery: routes/integrations.js
app.use('/api', require('./routes/integrations'));

// Modbus and RS232 profiles, entity catalogs, ports and test connections: routes/profiles.js
app.use('/api', require('./routes/profiles'));

app.post('/api/dashboard-config', isAuthenticated, (req, res) => {
  try {
    saveDashboardConfig(req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error saving dashboard config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard-config/export', isAuthenticated, (req, res) => {
  const config = getDashboardConfig();
  res.setHeader('Content-Disposition', 'attachment; filename="dashboard-layout.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(config);
});

app.post('/api/dashboard-config/import', isAuthenticated, upload.single('layout'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const uploaded = uploadedFilePath(req.file);
  if (!uploaded) return res.status(400).json({ error: 'Invalid upload' });
  try {
    const content = fs.readFileSync(uploaded, 'utf8');
    const imported = JSON.parse(content);
    if (!imported.dashboards || !Array.isArray(imported.dashboards)) {
      throw new Error('Invalid dashboard config format');
    }
    // Merge: add imported dashboards to existing ones, avoiding ID collisions
    if (req.query.merge !== 'false') {
      const existing = getDashboardConfig();
      const existingIds = new Set(existing.dashboards.map(d => d.id));
      for (const db of imported.dashboards) {
        if (existingIds.has(db.id)) {
          db.id = 'db_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          if (db.name) db.name += ' (imported)';
        }
        existing.dashboards.push(db);
        existingIds.add(db.id);
      }
      saveDashboardConfig(existing);
    } else {
      saveDashboardConfig(imported);
    }
    fs.unlinkSync(uploaded);
    res.json({ success: true });
  } catch (err) {
    if (fs.existsSync(uploaded)) fs.unlinkSync(uploaded);
    logger.error('Error importing dashboard config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('/api/backup', isAuthenticated);
app.use('/api/backup', require('./routes/backup')(backupDatabase));

// Restore and snapshot routes (and the session handover a restore needs): routes/restore.js
const restoreRoutes = require('./routes/restore')({ restoreDatabase, restoreFromSnapshot, listSnapshots, restoreLifecycle, sessionStore, upload, uploadedFilePath });
const { restoreSessionOptions, restoreFailure } = restoreRoutes;

// Remote backup: an encrypted copy of the newest snapshot, sent to a folder (Google Drive and WebDAV later).
const cloudBackup = require('./modules/cloudBackup').createCloudBackup({
  getConfig, setConfig, dataDir: path.dirname(require('./modules/database').DB_PATH),
  latestSnapshot: require('./modules/backup').latestManagedSnapshot,
  snapshotNow: require('./modules/backup').snapshotNow,
  emit: (type, fields) => require('./modules/notifications/events').emitEvent(type, fields),
  restore: restoreDatabase,
  readSpace: dir => require('./modules/storageStatus').readSpace(dir),
  logger
});
app.use('/api/cloud-backup', isAuthenticated, require('./routes/cloudBackup')(cloudBackup, {
  restoreOptions: req => ({ lifecycle: restoreLifecycle, ...restoreSessionOptions(req) }), restoreFailure
}));
cloudBackup.start();

app.use('/api/restore-jobs', isAuthenticated, require('./routes/restoreUploads')(restoreUploads));
app.use('/api', restoreRoutes.router);

app.use('/api', require('./routes/settings'));

// Device actions (switches, selectors, register writes) need the Controls
// unlock (password again within a few minutes), and every attempt is logged.
const deviceControls = require('./modules/deviceControls');
const deviceActions = require('./modules/deviceActions');
app.use('/api/controls', isAuthenticated, require('./routes/controls'));
app.use('/api/automations', isAuthenticated, require('./routes/automations'));
app.post('/api/action', isAuthenticated, deviceControls.requireUnlocked, async (req, res) => {
  const { status, body } = await deviceActions.performAction(req.body || {}, { req });
  res.status(status).json(body);
});

// Bluetooth BMS, Bluetooth adapter and wired BMS routes: routes/bms.js
app.use('/api', require('./routes/bms'));

// Tuya helper routes (discover, cloud fetch, QR login, test): routes/tuya.js
app.use('/api', require('./routes/tuya'));

app.use('/api/test-external', isAuthenticated);
app.post('/api/test-external', async (req, res) => {
  const { url, jsonPath } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    const response = await safeFetch(safeUrl, { signal: AbortSignal.timeout(5000) }, { allowPrivate: true }); // re-checks each redirect hop
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    let value = null;
    if (jsonPath) {
      const parts = jsonPath.split('.');
      let cur = data;
      for (const part of parts) cur = cur?.[part];
      value = cur;
    } else {
      value = data;
    }
    const num = parseFloat(value);
    res.json({ success: true, value: isNaN(num) ? value : num });
  } catch (err) {
    logger.error('Error testing external source:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AC-11 (#108): REST field catalog — flatten a live JSON document into
// deterministic scalar leaves {path,value,type,sample} with caps (depth ≤ 6
// segments, ≤ 500 leaves, arrays ≤ 100 items). Guard is EXACTLY the
// /api/test-external guard (assertSafeFetchUrl allowPrivate:true), 5s timeout,
// JSON only, and the error contract mirrors the test route. modules/external.js
// is untouched — this route never writes config or metrics.
app.use('/api/external/fields', isAuthenticated);
app.post('/api/external/fields', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required' });
  const { ok, error, url: safeUrl } = await assertSafeFetchUrl(url, { allowPrivate: true });
  if (!ok) return res.status(400).json({ error });
  try {
    const response = await safeFetch(safeUrl, { signal: AbortSignal.timeout(5000) }, { allowPrivate: true }); // re-checks each redirect hop
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const { leaves, truncated } = flattenJsonLeaves(data, REST_FLATTEN_DEFAULT_CAPS);
    res.json({ leaves, truncated, leafCount: leaves.length });
  } catch (err) {
    logger.error('Error fetching external fields:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== DONGLE ENDPOINTS (protected) ==========
app.use('/api', require('./routes/dongle'));

// ========== PVOUTPUT ROUTES ==========
// Public webhook (CSRF skipped in sessionAuth.js — called by PVOutput servers)
app.use('/api/pvoutput/webhook', pvoutput.webhookRouter);
// Protected routes
app.use('/api/pvoutput', isAuthenticated, pvoutput.router);
app.use('/api/notifications', isAuthenticated, require('./modules/notifications/routes').createRouter());
// Any browser that opens the dashboard can offer itself as a push device (js/push-prompt.js). It gets nothing until the admin picks it for a rule.
app.use('/api/push', require('./modules/notifications/routes').createPublicRouter());
// Settings → Logs: recent lines, the level (changed while running), downloads.
app.use('/api/logs', isAuthenticated, require('./routes/logs').router());
// Settings → Network → Remote access (Tailscale). Signed-in only, so never before the admin password exists.
app.use('/api/remote', isAuthenticated, require('./routes/remote').router());
// Settings → Updates: newer build out?, "Update now".
app.use('/api/updates', isAuthenticated, require('./routes/updates').router());

// ========== METRIC MANAGEMENT ENDPOINTS (protected): routes/metricManagement.js ==========
app.use('/api', require('./routes/metricManagement'));

// ---------- Visual Editor (protected) ----------
app.get('/editor', (req, res) => {
  if (!req.session || !req.session.authenticated) return res.redirect('/login');
  sendPage(res, path.join(__dirname, 'public', 'editor.html'), '/editor');
});

// ---------- Network config (public, read-only) ----------
app.get('/api/network-config', (req, res) => {
  const localURL = getConfig('network_local_url') || '';
  const remoteURL = getConfig('network_remote_url') || '';
  res.json({ localURL, remoteURL });
});

// ---------- Health probe (public, no auth) ----------
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ---------- Settings page (protected) ----------
app.get('/settings', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// ---------- Login page (public) ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// (The root route, /, is served ahead of the static files, near the top.)

// ---------- Metrics endpoints ----------
app.get('/api/metrics/current', async (req, res) => {
  try {
    res.json(getCurrentMetrics());
  } catch (err) {
    logger.error('Error in /api/metrics/current:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics/history', async (req, res) => {
  const metric = req.query.metric;
  if (!metric || typeof metric !== 'string' || metric.length > 128) return res.status(400).json({ error: 'metric is required (max 128 chars)' });
  const hours = parseInt(req.query.hours) || 24;
  // Public (dashboard) reads are capped at the 7 days the cards ask for: a
  // year of raw readings is a heavy response anyone could request. Signed in,
  // up to a year.
  const signedIn = !!(req.session && req.session.authenticated);
  const maxHours = signedIn ? 8760 : 168;
  if (isNaN(hours) || hours < 1) return res.status(400).json({ error: `hours must be 1-${maxHours}` });
  if (hours > maxHours) return res.status(signedIn ? 400 : 403).json({ error: signedIn ? 'hours must be 1-8760' : 'Without signing in, history covers up to 7 days (168 hours).' });
  try {
    res.json(getMetricHistory(metric, hours));
  } catch (err) {
    logger.error('Error in /api/metrics/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics/names', async (req, res) => {
  try {
    const rows = getDb().prepare('SELECT metric FROM latest_metrics ORDER BY metric').all();
    const names = rows.map(r => r.metric);
    res.json(names);
  } catch (err) {
    logger.error('Error in /api/metrics/names:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Catch-all for SPA ----------
app.use((req, res, next) => {
  if (ownsPrivatePath(req.path) || req.path.startsWith('/api') || req.path.startsWith('/settings') || req.path.startsWith('/login') || req.path.startsWith('/editor') || req.path.startsWith('/setup') || req.path.match(/\.(css|js|png|jpg|svg|ico)$/)) {
    return next();
  }
  sendPage(res, path.join(__dirname, 'public', 'index.html'), '/');
});

// 404 for unmatched /api routes (so they return JSON, not the SPA page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler: never leak a stack trace to the client (Express's default
// handler renders the full stack as HTML). Malformed JSON, oversized bodies
// and unexpected errors all return a short JSON message; the detail is logged.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) logger.error(`Unhandled ${req.method} ${req.originalUrl}: ${err.message}`);
  if (res.headersSent) return next(err);
  const message = err.type === 'entity.parse.failed' ? 'Invalid JSON body'
    : err.type === 'entity.too.large' ? 'Request body too large'
    : status < 500 ? (err.message || 'Bad request') : 'Internal server error';
  res.status(status).json({ error: message });
});

// Start HTTP server with WebSocket support
server.listen(PORT, () => logger.info(`Energy dashboard running on port ${PORT} (session-based auth, log level: ${process.env.LOG_LEVEL || 'info'}, time zone: ${timeZoneName()})`));

// ── Graceful Shutdown ──────────────────────────────────────────────────
// Something threw where nothing could catch it. State may be half done, so stop cleanly and
// let the supervisor (Docker's restart policy, systemd) start a fresh process; exit code 1 so
// `restart: on-failure` counts it. The timer covers a shutdown that itself hangs.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err && err.stack || err}`);
  const hard = setTimeout(() => process.exit(1), 5000); if (hard.unref) hard.unref();
  shutdown('uncaughtException', 1).catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled promise rejection: ${reason?.stack || reason}`);
});
let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);
  clearInterval(pollInterval);
  clearInterval(wsPingTimer);
  clearInterval(walCheckpointInterval);
  try { await shutdownRs232(); } catch (e) { logger.warn(`RS232 shutdown failed: ${e.message}`); }
  stopExternalPolling();
  stopBmsPolling();
  stopBmsWiredPolling();
  stopDonglePolling();
  require('./modules/tailscale').stopDaemon();
  require('./modules/cloudflared').stop();
  require('./modules/updates').stop();
  try { await require('./modules/ble').shutdownBle(); } catch (e) { logger.warn(`Bluetooth shutdown failed: ${e.message}`); }
  await restoreUploads.close();
  await stopSnapshotScheduler();
  await retention.stop();
  await stopRestoreStagingCleanup();
  try { pvoutput.stop(); } catch (e) { logger.warn(`PVOutput stop failed: ${e.message}`); }
  for (const client of mqttClients.values()) client.end(true);
  mqttClients.clear();
  require('./modules/haDiscoveryService').stop();
  for (const client of wsClients) client.terminate();
  wsClients.clear();
  wss.close();
  server.close();
  stopMetricAutoFlush();
  try { flushSync(); } catch (e) { logger.warn(`${signal} metric flush failed: ${e.message}`); }
  await require('./modules/dbCheck').stop();
  getDb().close();
  require('./modules/dbCheck').markCleanStop();
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch (_) { /* a later start makes a new one */ }
  logger.info('Shutdown complete');
  process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
