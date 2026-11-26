'use strict';
/**
 * The queries Epilykos sends to an InfluxDB, in InfluxQL (1.x) and Flux (2.x). Every name and value a user picks
 * (measurement, field, tag keys and values, database, bucket) is quoted and escaped here, so none of them can change
 * the shape of a query.
 *
 * A "series" is what one Epilykos metric maps to: { measurement, field, tags: { key: value } }.
 *
 * @module influx/queries
 */

const BUCKET = '5m';

// ── InfluxQL ────────────────────────────────────────────────────────────
const qlIdent = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const qlString = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function qlFrom(series, retentionPolicy) {
  return retentionPolicy ? `${qlIdent(retentionPolicy)}.${qlIdent(series.measurement)}` : qlIdent(series.measurement);
}

function qlWhere(series, from, to) {
  const parts = Object.entries(series.tags || {}).map(([k, v]) => `${qlIdent(k)} = ${qlString(v)}`);
  if (Number.isInteger(from)) parts.push(`time >= ${from}s`);
  if (Number.isInteger(to)) parts.push(`time < ${to}s`);
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

const influxql = {
  measurements: () => 'SHOW MEASUREMENTS',
  fieldKeys: measurement => `SHOW FIELD KEYS FROM ${qlIdent(measurement)}`,
  tagKeys: measurement => `SHOW TAG KEYS FROM ${qlIdent(measurement)}`,
  tagValues: (measurement, key) => `SHOW TAG VALUES FROM ${qlIdent(measurement)} WITH KEY = ${qlIdent(key)}`,
  /** The first reading of a series (its time tells how far back an import goes). */
  first: (series, { retentionPolicy } = {}) =>
    `SELECT first(${qlIdent(series.field)}) FROM ${qlFrom(series, retentionPolicy)}${qlWhere(series)}`,
  /** 5-minute buckets of a series over [from, to): mean, min, max and count, empty buckets left out. */
  buckets: (series, from, to, { retentionPolicy } = {}) => {
    const f = qlIdent(series.field);
    return `SELECT mean(${f}) AS "avg", min(${f}) AS "min", max(${f}) AS "max", count(${f}) AS "count" FROM ${qlFrom(series, retentionPolicy)}`
      + `${qlWhere(series, from, to)} GROUP BY time(${BUCKET}) fill(none)`;
  },
};

// ── Flux ────────────────────────────────────────────────────────────────
// A Flux string: backslash, double quote and "${" (string interpolation) escaped, and control characters written out.
const fxString = s => '"' + String(s)
  .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$\{/g, '\\${')
  .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
const fxTime = seconds => new Date(seconds * 1000).toISOString();

function fxFilter(series) {
  const parts = [`r._measurement == ${fxString(series.measurement)}`, `r._field == ${fxString(series.field)}`];
  for (const [k, v] of Object.entries(series.tags || {})) parts.push(`r[${fxString(k)}] == ${fxString(v)}`);
  return `filter(fn: (r) => ${parts.join(' and ')})`;
}

const SCHEMA_START = '-10y';   // the schema functions look back 30 days unless told otherwise; history can be years old

const flux = {
  bucketExists: bucket => `buckets() |> filter(fn: (r) => r.name == ${fxString(bucket)}) |> keep(columns: ["name"])`,
  measurements: bucket => `import "influxdata/influxdb/schema"\nschema.measurements(bucket: ${fxString(bucket)}, start: ${SCHEMA_START})`,
  fieldKeys: (bucket, measurement) =>
    `import "influxdata/influxdb/schema"\nschema.measurementFieldKeys(bucket: ${fxString(bucket)}, measurement: ${fxString(measurement)}, start: ${SCHEMA_START})`,
  tagKeys: (bucket, measurement) =>
    `import "influxdata/influxdb/schema"\nschema.measurementTagKeys(bucket: ${fxString(bucket)}, measurement: ${fxString(measurement)}, start: ${SCHEMA_START})`,
  tagValues: (bucket, measurement, key) =>
    `import "influxdata/influxdb/schema"\nschema.measurementTagValues(bucket: ${fxString(bucket)}, measurement: ${fxString(measurement)}, tag: ${fxString(key)}, start: ${SCHEMA_START})`,
  first: (bucket, series) =>
    `from(bucket: ${fxString(bucket)}) |> range(start: 0) |> ${fxFilter(series)} |> group() |> first() |> keep(columns: ["_time", "_value"])`,
  buckets: (bucket, series, from, to) => [
    `data = from(bucket: ${fxString(bucket)}) |> range(start: ${fxTime(from)}, stop: ${fxTime(to)}) |> ${fxFilter(series)} |> group() |> toFloat()`,
    'agg = (fn, name) => data |> aggregateWindow(every: ' + BUCKET + ', fn: fn, createEmpty: false, timeSrc: "_start") |> toFloat() |> set(key: "agg", value: name)',
    'union(tables: [agg(fn: mean, name: "avg"), agg(fn: min, name: "min"), agg(fn: max, name: "max"), agg(fn: count, name: "count")])',
    '  |> group() |> keep(columns: ["_time", "_value", "agg"])',
  ].join('\n'),
};

module.exports = { influxql, flux, qlIdent, qlString, fxString, fxTime, BUCKET_SECONDS: 300 };
