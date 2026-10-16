'use strict';
/**
 * modules/notifications/events.js — the project-wide notification event bus.
 *
 * Any module can raise an event with emitEvent(type, fields); event rules
 * (kind 'event') match on the type, so a new event needs no other wiring
 * than a catalog entry here (the catalog only feeds the settings UI — an
 * uncatalogued type still reaches rules that name it or a wildcard).
 *
 * Event shape: { type, title, message, severity, subject, data, timestamp }
 *   subject — what the event is about (source id, broker, ...); rules may
 *   filter on it and cooldowns are kept per rule + subject.
 */

const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

const SEVERITIES = ['info', 'warning', 'critical'];

/** type → { label, category, severity (default), description } */
const EVENT_TYPES = {
  'grid.off': { label: 'Grid outage started', category: 'Grid', severity: 'critical', description: 'The grid status metric went OFF.' },
  'grid.on': { label: 'Grid restored', category: 'Grid', severity: 'info', description: 'The grid status metric came back ON, with the outage length.' },
  'source.offline': { label: 'Source stopped responding', category: 'Sources', severity: 'warning', description: 'A polled source (Home Assistant, Modbus, Tuya, RS232, grid) failed 3 polls in a row.' },
  'source.online': { label: 'Source responding again', category: 'Sources', severity: 'info', description: 'A source that was offline answered a poll.' },
  'mqtt.disconnected': { label: 'MQTT broker disconnected', category: 'Sources', severity: 'warning', description: 'The connection to an MQTT broker dropped.' },
  'mqtt.connected': { label: 'MQTT broker reconnected', category: 'Sources', severity: 'info', description: 'An MQTT broker connection came back after a drop.' },
  'pvoutput.alert': { label: 'PVOutput alert received', category: 'Uploads', severity: 'warning', description: 'PVOutput sent an alert to the webhook.' },
  'forecast.unavailable': { label: 'Solar forecast unavailable', category: 'Forecast', severity: 'warning', description: 'Solcast (for example its daily quota running out) or Open-Meteo could not be reached.' },
  'backup.snapshot_failed': { label: 'Automatic snapshot failed', category: 'System', severity: 'warning', description: 'The daily database snapshot could not be written.' },
  'update.available': { label: 'Update available', category: 'System', severity: 'info', description: 'A newer Epilykos build is out: a new release, or the weekly rebuild with security updates. Sent once per build.' },
  'system.started': { label: 'Epilykos started', category: 'System', severity: 'info', description: 'The server started (after an update, a reboot or a crash).' },
};

/**
 * Raise an event. Never throws: a listener failure must not break the
 * module that raised it.
 */
function emitEvent(type, fields = {}) {
  const meta = EVENT_TYPES[type] || {};
  const event = {
    type,
    title: fields.title || meta.label || type,
    message: fields.message || '',
    severity: SEVERITIES.includes(fields.severity) ? fields.severity : (meta.severity || 'info'),
    subject: fields.subject != null ? String(fields.subject) : '',
    data: fields.data || {},
    timestamp: fields.timestamp || Math.floor(Date.now() / 1000),
  };
  try { bus.emit('event', event); } catch (_) { /* listeners log their own errors */ }
  return event;
}

function onEvent(fn) { bus.on('event', fn); return () => bus.off('event', fn); }

/** Catalog for the settings UI: [{ type, label, category, severity, description }]. */
function listEventTypes() {
  return Object.entries(EVENT_TYPES).map(([type, m]) => ({ type, ...m }));
}

/**
 * Does `pattern` (from a rule) match event `type`? Exact, '*' for every
 * event, or a 'prefix.*' wildcard ('source.*').
 */
function eventMatches(pattern, type) {
  if (!pattern || !type) return false;
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return false;
}

module.exports = { emitEvent, onEvent, listEventTypes, eventMatches, EVENT_TYPES, SEVERITIES };
