'use strict';
/**
 * InfluxDB line protocol, for the readings Epilykos writes: one numeric field per point, second precision.
 *
 *   measurement,tag=value,tag2=value2 field=1.5 1700000000
 *
 * Escaping follows the line protocol reference: in a measurement, commas and spaces; in tag keys, tag values and field keys,
 * commas, equals signs and spaces; backslashes before those. A name with a newline (or other control character) cannot be
 * written at all, so such a point is refused rather than sent broken.
 *
 * @module influx/lineProtocol
 */

const CONTROL = /[\u0000-\u001f\u007f]/;

const escapeMeasurement = s => String(s).replace(/\\/g, '\\\\').replace(/([, ])/g, '\\$1');
const escapeKey = s => String(s).replace(/\\/g, '\\\\').replace(/([,= ])/g, '\\$1');

const usable = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !CONTROL.test(s) && !s.endsWith('\\');

/** A number as InfluxDB reads it: finite, with no exponent surprises for very large or small values. */
function formatNumber(n) {
  if (Number.isInteger(n)) return `${n}`;   // written without "i": a float field, so the type never changes between points
  return String(n);
}

/**
 * One line, or null when the point cannot be written (bad name, not a finite number, bad time).
 * @param {{measurement: string, tags?: Record<string,string>, field: string, value: number, timestamp: number}} p timestamp in seconds
 */
function formatPoint({ measurement, tags = {}, field, value, timestamp }) {
  if (!usable(measurement) || !usable(field) || !Number.isFinite(value) || !Number.isInteger(timestamp) || timestamp < 0) return null;
  let line = escapeMeasurement(measurement);
  for (const key of Object.keys(tags).sort()) {          // sorted: the order InfluxDB stores them in, and cheaper for it to write
    const v = tags[key];
    if (v === undefined || v === null || v === '') continue;  // an empty tag value is not allowed in line protocol
    if (!usable(key) || !usable(String(v))) return null;
    line += `,${escapeKey(key)}=${escapeKey(v)}`;
  }
  return `${line} ${escapeKey(field)}=${formatNumber(value)} ${timestamp}`;
}

module.exports = { formatPoint, escapeMeasurement, escapeKey };
