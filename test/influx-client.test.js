'use strict';
const checks = require('./_checks');
/**
 * modules/influx: line protocol, the InfluxQL and Flux queries (every user-chosen name escaped), and the client against a
 * fake InfluxDB 1.x and 2.x: connection test, discovery, 5-minute buckets, writes, errors that never carry a secret, and the
 * SSRF guard (loopback refused even though LAN addresses are allowed).
 */
const assert = require('assert');
const { formatPoint } = require('../modules/influx/lineProtocol');
const { influxql, flux, fxString, qlIdent, qlString } = require('../modules/influx/queries');
const { createInfluxClient, parseFluxCsv } = require('../modules/influx/client');
const { createFakeInflux, fluxCsv, qlAnswer, directFetch } = require('./_fake-influx');

// ── Line protocol ───────────────────────────────────────────────────────
assert.strictEqual(formatPoint({ measurement: 'epilykos', tags: { metric: 'pv power' }, field: 'value', value: 1.5, timestamp: 1700000000 }),
  'epilykos,metric=pv\\ power value=1.5 1700000000');
assert.strictEqual(formatPoint({ measurement: 'a,b c', tags: { 'k=1': 'v,2', z: 'x', a: 'y' }, field: 'f=x', value: 3, timestamp: 1 }),
  'a\\,b\\ c,a=y,k\\=1=v\\,2,z=x f\\=x=3 1', 'escaping, and tags in sorted order');
assert.strictEqual(formatPoint({ measurement: 'm', tags: { t: '' }, field: 'v', value: 1, timestamp: 1 }), 'm v=1 1', 'an empty tag is left out');
for (const bad of [
  { measurement: 'm\nDROP', field: 'v', value: 1, timestamp: 1 },
  { measurement: 'm', tags: { t: 'a\nb' }, field: 'v', value: 1, timestamp: 1 },
  { measurement: 'm', field: 'v', value: NaN, timestamp: 1 },
  { measurement: 'm', field: 'v', value: Infinity, timestamp: 1 },
  { measurement: 'm', field: 'v', value: 1, timestamp: 1.5 },
  { measurement: '', field: 'v', value: 1, timestamp: 1 },
  { measurement: 'm\\', field: 'v', value: 1, timestamp: 1 },
]) assert.strictEqual(formatPoint(bad), null, JSON.stringify(bad));

// ── Queries: names are quoted, never spliced ────────────────────────────
assert.strictEqual(qlIdent('a"b\\c'), '"a\\"b\\\\c"');
assert.strictEqual(qlString("it's"), "'it\\'s'");
const evil = { measurement: 'W"; DROP DATABASE "x', field: "value' OR 1=1", tags: { 'entity_id': "pv'; DROP" } };
const q1 = influxql.buckets(evil, 100, 200, { retentionPolicy: 'autogen' });
assert.strictEqual(q1, `SELECT mean("value' OR 1=1") AS "avg", min("value' OR 1=1") AS "min", max("value' OR 1=1") AS "max", count("value' OR 1=1") AS "count" FROM "autogen"."W\\"; DROP DATABASE \\"x" WHERE "entity_id" = 'pv\\'; DROP' AND time >= 100s AND time < 200s GROUP BY time(5m) fill(none)`);
assert.strictEqual(fxString('a"${x}\\\n'), '"a\\"\\${x}\\\\\\n"', 'Flux: quotes, interpolation, backslash, newline');
const f1 = flux.buckets('home', { measurement: 'W', field: 'value', tags: { entity_id: 'x"${y}' } }, 0, 300);
assert.ok(f1.includes('r["entity_id"] == "x\\"\\${y}"'), f1);
assert.ok(f1.includes('range(start: 1970-01-01T00:00:00.000Z, stop: 1970-01-01T00:05:00.000Z)'));

// ── Flux CSV ────────────────────────────────────────────────────────────
assert.deepStrictEqual(parseFluxCsv(',result,table,_value\r\n,_result,0,"a,""b"""\r\n,_result,0,c\r\n\r\n,result,table,x\r\n,_result,1,9\r\n'),
  [{ result: '_result', table: '0', _value: 'a,"b"' }, { result: '_result', table: '0', _value: 'c' }, { result: '_result', table: '1', x: '9' }]);

// ── Settings are checked before anything is sent ────────────────────────
assert.throws(() => createInfluxClient({ version: '3', url: 'http://h' }), /1\.x or 2\.x/);
assert.throws(() => createInfluxClient({ version: '2', url: 'ftp://h', org: 'o', bucket: 'b', token: 't' }), /http/);
assert.throws(() => createInfluxClient({ version: '2', url: 'http://u:p@h', org: 'o', bucket: 'b', token: 't' }), /own fields/);
assert.throws(() => createInfluxClient({ version: '2', url: 'http://h', org: 'o', bucket: 'b' }), /token/);
assert.throws(() => createInfluxClient({ version: '1', url: 'http://h' }), /database/);

(async () => {
  // ── The SSRF guard: loopback refused, with no fetch override ──────────
  await assert.rejects(createInfluxClient({ version: '2', url: 'http://127.0.0.1:8086', org: 'o', bucket: 'b', token: 't' }).test(), /not allowed/);
  await assert.rejects(createInfluxClient({ version: '1', url: 'http://169.254.169.254', database: 'd' }).test(), /not allowed/);

  // ── 2.x ───────────────────────────────────────────────────────────────
  const T0 = 1_700_000_100;   // a 5-minute boundary
  const iso = s => new Date(s * 1000).toISOString();
  const v2 = createFakeInflux({ version: '2', token: 'secret-token', answer: (kind, q) => {
    if (q.includes('"bad"')) return { status: 400, body: JSON.stringify({ code: 'invalid', message: 'error @1:1: bad query' }) };
    if (q.startsWith('buckets()')) return q.includes('"home"') ? fluxCsv([{ name: 'home' }]) : '';
    if (q.includes('schema.measurements')) return fluxCsv([{ _value: 'W' }, { _value: '%' }, { _value: 'W' }]);
    if (q.includes('measurementFieldKeys')) return fluxCsv([{ _value: 'value' }, { _value: 'friendly_name_str' }]);
    if (q.includes('measurementTagKeys')) return fluxCsv([{ _value: '_measurement' }, { _value: 'entity_id' }, { _value: 'domain' }]);
    if (q.includes('measurementTagValues')) return fluxCsv([{ _value: 'pv_power' }, { _value: 'load_power' }]);
    if (q.includes('|> last()')) return fluxCsv([
      { _start: iso(T0), _stop: iso(T0), _time: iso(T0), _value: 91.5, _field: 'usage_idle', _measurement: 'cpu', cpu: 'cpu-total', host: 'pi' },
      { _start: iso(T0), _stop: iso(T0), _time: iso(T0), _value: 'ok', _field: 'state', _measurement: 'cpu', cpu: 'cpu-total', host: 'pi' },
      { _start: iso(T0), _stop: iso(T0), _time: iso(T0), _value: 4, _field: 'usage_user', _measurement: 'cpu', cpu: '', host: 'pi' },
    ]);
    if (q.includes('first()')) return fluxCsv([{ _time: iso(T0 - 86400), _value: 5 }]);
    if (q.includes('aggregateWindow')) return fluxCsv([
      { _time: iso(T0), _value: 150, agg: 'avg' }, { _time: iso(T0), _value: 100, agg: 'min' }, { _time: iso(T0), _value: 200, agg: 'max' }, { _time: iso(T0), _value: 3, agg: 'count' },
      { _time: iso(T0 + 300), _value: 10, agg: 'avg' }, { _time: iso(T0 + 300), _value: 10, agg: 'min' }, { _time: iso(T0 + 300), _value: 10, agg: 'max' }, { _time: iso(T0 + 300), _value: 1, agg: 'count' },
      { _time: iso(T0 + 600), _value: '', agg: 'avg' },
    ]);
    return '';
  } });
  const url2 = await v2.listen();
  const c2 = createInfluxClient({ version: '2', url: url2 + '/', org: 'my org', bucket: 'home', token: 'secret-token' }, { fetchImpl: directFetch });
  assert.deepStrictEqual(await c2.test(), { ok: true });
  assert.strictEqual(v2.log[0].params.org, 'my org');
  assert.strictEqual(v2.log[0].auth, 'Token secret-token');
  assert.deepStrictEqual(await c2.measurements(), ['%', 'W']);
  assert.deepStrictEqual(await c2.fieldKeys('W'), [{ name: 'friendly_name_str', type: null }, { name: 'value', type: null }]);
  assert.deepStrictEqual(await c2.tagKeys('W'), ['domain', 'entity_id'], 'the internal _measurement key is not offered');
  assert.deepStrictEqual(await c2.tagValues('W', 'entity_id'), ['load_power', 'pv_power']);
  const series = { measurement: 'W', field: 'value', tags: { entity_id: 'pv_power' } };
  assert.strictEqual(await c2.first(series), T0 - 86400);
  assert.deepStrictEqual(await c2.series('cpu'), [
    { measurement: 'cpu', field: 'usage_idle', tags: { cpu: 'cpu-total', host: 'pi' }, last: 91.5, time: T0 },
    { measurement: 'cpu', field: 'usage_user', tags: { host: 'pi' }, last: 4, time: T0 },
  ], 'every series of a measurement with its latest number; text fields and empty tags left out');
  assert.ok(v2.log[v2.log.length - 1].query.includes('range(start: -30d)'));
  assert.deepStrictEqual(await c2.buckets(series, T0, T0 + 900), [
    { bucket_start: T0, avg: 150, min: 100, max: 200, count: 3 },
    { bucket_start: T0 + 300, avg: 10, min: 10, max: 10, count: 1 },
  ], 'the four aggregates joined per bucket; an incomplete bucket dropped');
  await c2.write(['epilykos,metric=pv value=1 1700000000', 'epilykos,metric=load value=2 1700000000']);
  assert.deepStrictEqual(v2.written, ['epilykos,metric=pv value=1 1700000000', 'epilykos,metric=load value=2 1700000000']);
  const w = v2.log[v2.log.length - 1];
  assert.deepStrictEqual([w.path, w.params.bucket, w.params.precision], ['/api/v2/write', 'home', 's']);

  const other = createInfluxClient({ version: '2', url: url2, org: 'o', bucket: 'nope', token: 'secret-token' }, { fetchImpl: directFetch });
  await assert.rejects(other.test(), /no bucket "nope"/);
  const wrong = createInfluxClient({ version: '2', url: url2, org: 'o', bucket: 'home', token: 'not-it' }, { fetchImpl: directFetch });
  await assert.rejects(wrong.test(), e => e.kind === 'auth' && /refused the token/.test(e.message) && !/not-it/.test(e.message));
  v2.state.failWrites = 1;
  await assert.rejects(c2.write(['m v=1 1']), e => e.status === 503 && !/secret-token/.test(e.message));
  await assert.rejects(c2.first({ measurement: 'bad', field: 'v' }), e => e.kind === 'http' && /bad query/.test(e.message), 'the server\'s error is passed on');
  await v2.close();

  // ── 1.x ───────────────────────────────────────────────────────────────
  // Made up for this test, and built at run time so a secret scanner does not mistake them for real ones.
  const USER = ['test', 'reader'].join('-'), PASS = ['not', 'a', 'real', 'one'].join('-'), WRONG = ['also', 'made', 'up'].join('-');
  const v1 = createFakeInflux({ version: '1', user: USER, password: PASS, answer: (kind, q, req) => {
    if (req.params.db === 'nope') return { results: [{ statement_id: 0, error: 'database not found: nope' }] };
    if (q.startsWith('SHOW MEASUREMENTS LIMIT 1')) return qlAnswer(['name'], [['W']], 'measurements');
    if (q === 'SHOW MEASUREMENTS') return qlAnswer(['name'], [['W'], ['kWh']], 'measurements');
    if (q.startsWith('SHOW FIELD KEYS')) return qlAnswer(['fieldKey', 'fieldType'], [['value', 'float'], ['state', 'string']]);
    if (q.startsWith('SHOW TAG KEYS')) return qlAnswer(['tagKey'], [['entity_id'], ['domain']]);
    if (q.startsWith('SHOW TAG VALUES')) return qlAnswer(['key', 'value'], [['entity_id', 'pv_power']]);
    if (q.startsWith('SELECT last(*)')) return { results: [{ statement_id: 0, series: [
      { name: 'cpu', tags: { cpu: 'cpu0', host: 'pi' }, columns: ['time', 'last_usage_idle', 'last_state'], values: [[T0, 88, 'ok']] },
      { name: 'cpu', tags: { cpu: 'cpu-total', host: 'pi' }, columns: ['time', 'last_usage_idle', 'last_state'], values: [[T0, 91.5, null]] },
    ] }] };
    if (q.startsWith('SELECT first')) return qlAnswer(['time', 'first'], [[T0 - 3600, 1]]);
    if (q.startsWith('SELECT mean')) return qlAnswer(['time', 'avg', 'min', 'max', 'count'], [[T0, 2.5, 1, 4, 4], [T0 + 300, null, null, null, 0]]);
    return null;
  } });
  const url1 = await v1.listen();
  const c1 = createInfluxClient({ version: '1', url: url1, database: 'home_assistant', retentionPolicy: 'autogen', username: USER, password: PASS }, { fetchImpl: directFetch });
  assert.deepStrictEqual(await c1.test(), { ok: true });
  assert.deepStrictEqual([v1.log[0].params.db, v1.log[0].params.rp, v1.log[0].params.epoch], ['home_assistant', 'autogen', 's']);
  assert.deepStrictEqual(await c1.measurements(), ['W', 'kWh']);
  assert.deepStrictEqual(await c1.fieldKeys('W'), [{ name: 'value', type: 'float' }, { name: 'state', type: 'string' }]);
  assert.deepStrictEqual(await c1.tagKeys('W'), ['domain', 'entity_id']);
  assert.deepStrictEqual(await c1.tagValues('W', 'entity_id'), ['pv_power']);
  assert.strictEqual(await c1.first(series), T0 - 3600);
  assert.deepStrictEqual((await c1.series('cpu')).map(x => [x.field, x.tags.cpu, x.last]), [['usage_idle', 'cpu-total', 91.5], ['usage_idle', 'cpu0', 88]]);
  assert.strictEqual(v1.log[v1.log.length - 1].query, 'SELECT last(*) FROM "autogen"."cpu" WHERE time > now() - 30d GROUP BY *');
  assert.deepStrictEqual(await c1.buckets(series, T0, T0 + 600), [{ bucket_start: T0, avg: 2.5, min: 1, max: 4, count: 4 }]);
  assert.ok(v1.log[v1.log.length - 1].query.includes('FROM "autogen"."W" WHERE "entity_id" = \'pv_power\''));
  await c1.write(['epilykos,metric=pv value=1 1']);
  assert.deepStrictEqual([v1.log[v1.log.length - 1].path, v1.log[v1.log.length - 1].params.db, v1.written[0]], ['/write', 'home_assistant', 'epilykos,metric=pv value=1 1']);

  const badPw = createInfluxClient({ version: '1', url: url1, database: 'd', username: USER, password: WRONG }, { fetchImpl: directFetch });
  await assert.rejects(badPw.test(), e => e.kind === 'auth' && !e.message.includes(WRONG));
  const noDb = createInfluxClient({ version: '1', url: url1, database: 'nope', username: USER, password: PASS }, { fetchImpl: directFetch });
  await assert.rejects(noDb.test(), /database not found/);
  await v1.close();

  // ── A server that does not answer ─────────────────────────────────────
  const down = createInfluxClient({ version: '1', url: 'http://10.255.255.1:9', database: 'd' }, { fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')) });
  await assert.rejects(down.test(), e => e.kind === 'network' && /Could not reach/.test(e.message));

  console.log('ok - influx client');
  checks.done();
})().catch(e => { console.error(e); process.exit(1); });
