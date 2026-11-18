'use strict';
/**
 * Where an alert should take you, and which alerts belong together.
 *
 * pathFor(type)  the page a click on the alert opens (a path on this Epilykos, never another site)
 * threadFor()    alerts about the same thing share a thread: "grid restored" replaces "grid outage" on a
 *                device's screen (same notification tag) and marks it resolved in the inbox
 */

const PATHS = {
  'grid.off': '/', 'grid.on': '/',
  'generator.on': '/', 'generator.off': '/',
  'source.offline': '/settings#sources', 'source.online': '/settings#sources',
  'mqtt.disconnected': '/settings#sources', 'mqtt.connected': '/settings#sources',
  'pvoutput.alert': '/settings#uploads',
  'forecast.unavailable': '/settings#forecast',
  'backup.snapshot_overdue': '/settings#backup', 'backup.snapshot_failed': '/settings#backup',
  'backup.cloud_failed': '/settings#backup', 'backup.cloud_overdue': '/settings#backup',
  'update.available': '/settings#updates',
  'prepaid.low': '/settings#prepaid', 'prepaid.out': '/settings#prepaid',
  'system.started': '/settings#logs',
};

/** The page for an event type; the dashboard when there is nothing more specific. */
function pathFor(type) {
  return PATHS[type] || '/';
}

// The event that ends a problem, and the thread it shares with the one that started it.
const THREADS = {
  'grid.off': 'grid', 'grid.on': 'grid',
  'generator.on': 'generator', 'generator.off': 'generator',
  'source.offline': 'source', 'source.online': 'source',
  'mqtt.disconnected': 'mqtt', 'mqtt.connected': 'mqtt',
};
const ENDS = new Set(['grid.on', 'generator.off', 'source.online', 'mqtt.connected']);

/** Thread key for an event ('grid', 'source-ha', ...), or null for an event that stands alone. */
function threadFor(type, subject) {
  const base = THREADS[type];
  if (!base) return null;
  return subject ? `${base}-${subject}` : base;
}

/** Does this event end the problem an earlier one in its thread started? */
function resolvesThread(type) { return ENDS.has(type); }

module.exports = { pathFor, threadFor, resolvesThread, PATHS };
