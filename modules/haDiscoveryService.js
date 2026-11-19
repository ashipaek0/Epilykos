'use strict';
/**
 * The running Home Assistant discovery publisher (see haDiscovery.js), wired to the real database and a real MQTT
 * client. One per process. start() and stop() are safe to call at any time; they never throw.
 */
const mqtt = require('mqtt');
const { logger } = require('./logger');
const { getConfig, getDb, onMetricsFlushed } = require('./database');
const { createHaDiscovery, CONFIG_KEY } = require('./haDiscovery');

let svc = null;
const json = (key, fallback) => { try { const v = JSON.parse(getConfig(key) || 'null'); return v == null ? fallback : v; } catch (_) { return fallback; } };

function service() {
  if (!svc) {
    svc = createHaDiscovery({
      connect: (url, opts) => mqtt.connect(url, opts),
      readConfig: () => json(CONFIG_KEY, {}),
      readRoles: () => json('role_metrics', {}),
      getLatest: () => getDb().prepare('SELECT metric, value, value_text, value_type, unit, timestamp FROM latest_metrics').all(),
      onFlushed: onMetricsFlushed,
      version: (() => { try { return require('./version').appVersion(); } catch (_) { return ''; } })(),
      log: logger,
    });
  }
  return svc;
}

function start() { try { service().start(); } catch (e) { logger.warn(`Home Assistant discovery did not start: ${e.message}`); } }
function stop() { try { if (svc) svc.stop(); } catch (e) { logger.warn(`Home Assistant discovery did not stop: ${e.message}`); } }

module.exports = { service, start, stop };
