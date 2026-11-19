'use strict';
const checks = require('./_checks');
// Alert rules that combine metrics ("all" / "any" of up to three conditions): the truth rules, the lifecycle
// (fire, hold, resolve, repeat, cooldown, "for at least"), missing data, saving, and the message.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-condition-'));
process.chdir(tmp);
process.env.ENC_KEY_FILE = path.join(tmp, 'encryption-key');
const { initializeDatabase } = require('../modules/database');
initializeDatabase();
const rules = require('../modules/notifications/rules');
const store = require('../modules/notifications/store');
const { normalizeRule } = require('../modules/notifications/routes');

const clause = (metric, operator, value, extra) => Object.assign({ metric, operator, value }, extra || {});
const rule = (o) => Object.assign({ id: 'r1', kind: 'condition', enabled: true, name: 'Low battery, poor sun', join: 'all', for_s: 0, cooldown_s: 0, notify_resolved: true,
  clauses: [clause('soc', 'lt', 20, { hysteresis: 5 }), clause('fc', 'lt', 5)] }, o || {});
const rows = (o) => new Map(Object.entries(o).map(([k, v]) => [k, v === null ? undefined : { value: v, timestamp: 1000, unit: k === 'soc' ? '%' : 'kWh' }]).filter(([, v]) => v));

// ── Truth rules ──────────────────────────────────────────────────────────
const met = (r, vals, phase) => rules.combinedMet(r, require('../modules/notifications/rules').createMetricEvaluator && detailsFor(r, rows(vals)), 2000, phase);
const detailsFor = (r, map) => r.clauses.map(c => ({ clause: c, row: map.get(c.metric), reading: map.get(c.metric) ? map.get(c.metric).value : null }));
assert.equal(met(rule(), { soc: 10, fc: 2 }), true, 'all: both true');
assert.equal(met(rule(), { soc: 10, fc: 9 }), false, 'all: one false');
assert.equal(met(rule(), { soc: 10, fc: null }), null, 'all: one true, one without data: cannot say');
assert.equal(met(rule(), { soc: 50, fc: null }), false, 'all: one false is enough, even with the other missing');
assert.equal(met(rule(), { soc: null, fc: null }), null);
const any = rule({ join: 'any' });
assert.equal(met(any, { soc: 50, fc: 2 }), true, 'any: one true');
assert.equal(met(any, { soc: 50, fc: 9 }), false, 'any: none true');
assert.equal(met(any, { soc: 50, fc: null }), null, 'any: one false, one without data');
assert.equal(met(any, { soc: 10, fc: null }), true, 'any: a true clause decides');
assert.equal(met(rule({ clauses: [clause('mode', 'eq', 'Battery'), clause('soc', 'lt', 20)] }), {}, 'idle'), null, 'no data at all');
// text clauses compare case-insensitively, as metric rules do
const textMap = new Map([['mode', { value: null, value_text: 'battery', timestamp: 1 }], ['soc', { value: 10, timestamp: 1 }]]);
assert.equal(rules.combinedMet(rule({ clauses: [clause('mode', 'eq', 'Battery'), clause('soc', 'lt', 20)] }), detailsFor({ clauses: [clause('mode', 'eq', 'Battery'), clause('soc', 'lt', 20)] }, new Map([['mode', { value: null, value_text: 'battery', timestamp: 1 }], ['soc', { value: 10, timestamp: 1 }]])).map(d => d.row && d.row.value_text ? { ...d, reading: d.row.value_text } : d), 2000, 'idle'), true);
// stale clause: no update for N minutes
const staleRule = rule({ clauses: [clause('soc', 'stale', 10), clause('fc', 'lt', 5)] });
assert.equal(rules.combinedMet(staleRule, [{ clause: staleRule.clauses[0], row: { timestamp: 1000 }, reading: 1 }, { clause: staleRule.clauses[1], row: { timestamp: 1000, value: 1 }, reading: 1 }], 1000 + 11 * 60, 'idle'), true);

// ── Validity ─────────────────────────────────────────────────────────────
assert.equal(rules.validClauses(rule()), true);
assert.equal(rules.validClauses(rule({ clauses: [] })), false);
assert.equal(rules.validClauses(rule({ clauses: [1, 2, 3, 4].map(i => clause('m' + i, 'gt', i)) })), false, 'at most three');
assert.equal(rules.validClauses(rule({ clauses: [clause('a', 'changes', '')] })), false, '"changes" is for metric rules');
assert.equal(rules.validClauses(rule({ clauses: [clause('', 'gt', 1)] })), false);
assert.equal(rules.MAX_CLAUSES, 3);

// ── Lifecycle ────────────────────────────────────────────────────────────
function run(r, steps) {
  const ev = rules.createMetricEvaluator(); const out = [];
  for (const [now, vals] of steps) out.push(ev.evaluate([r], rows(vals), now).map(h => h.transition));
  return out;
}
assert.deepEqual(run(rule(), [[100, { soc: 10, fc: 2 }], [130, { soc: 10, fc: 2 }], [160, { soc: 30, fc: 2 }]]), [['fire'], [], ['resolve']], 'fires once, holds, resolves once');
assert.deepEqual(run(rule(), [[100, { soc: 10, fc: 2 }], [130, { soc: 22, fc: 2 }], [160, { soc: 26, fc: 2 }]]), [['fire'], [], ['resolve']], 'hysteresis: 22 is inside the margin (stays on), 26 clears');
assert.deepEqual(run(rule({ notify_resolved: false }), [[100, { soc: 10, fc: 2 }], [130, { soc: 90, fc: 2 }]]), [['fire'], []], 'no resolve message unless asked');
assert.deepEqual(run(rule({ for_s: 300 }), [[100, { soc: 10, fc: 2 }], [200, { soc: 10, fc: 2 }], [450, { soc: 10, fc: 2 }]]), [[], [], ['fire']], '"for at least" waits');
assert.deepEqual(run(rule({ for_s: 300 }), [[100, { soc: 10, fc: 2 }], [200, { soc: 50, fc: 2 }], [300, { soc: 10, fc: 2 }], [450, { soc: 10, fc: 2 }]]), [[], [], [], []], 'a blip resets the wait');
assert.deepEqual(run(rule({ repeat_s: 600 }), [[100, { soc: 10, fc: 2 }], [400, { soc: 10, fc: 2 }], [800, { soc: 10, fc: 2 }]]), [['fire'], [], ['repeat']], 'reminders');
assert.deepEqual(run(rule({ cooldown_s: 3600 }), [[100, { soc: 10, fc: 2 }], [200, { soc: 90, fc: 2 }], [300, { soc: 10, fc: 2 }], [400, { soc: 90, fc: 2 }]]), [['fire'], ['resolve'], [], []], 'the second fire inside the cooldown is silent, and so is its resolve');
// A source dropping out neither fires nor resolves.
assert.deepEqual(run(rule(), [[100, { soc: 10, fc: 2 }], [130, { soc: 10, fc: null }]]), [['fire'], []], 'missing data does not resolve');
assert.deepEqual(run(rule(), [[100, { soc: 10, fc: null }], [130, { soc: 10, fc: null }]]), [[], []], 'and does not fire');
// A changed rule starts over.
const ev = rules.createMetricEvaluator();
assert.equal(ev.evaluate([rule()], rows({ soc: 10, fc: 2 }), 100).length, 1);
assert.equal(ev.evaluate([rule({ clauses: [clause('soc', 'lt', 20, { hysteresis: 5 }), clause('fc', 'lt', 6)] })], rows({ soc: 10, fc: 2 }), 130).length, 1, 'edit a threshold, it is judged afresh');
// Metric and condition rules run side by side.
const both = rules.createMetricEvaluator().evaluate([rule(), { id: 'm', kind: 'metric', enabled: true, name: 'Low', metric: 'soc', operator: 'lt', value: 20, for_s: 0, cooldown_s: 0 }], rows({ soc: 10, fc: 2 }), 100);
assert.deepEqual(both.map(h => h.rule.id).sort(), ['m', 'r1']);
// A disabled or malformed rule is skipped.
assert.deepEqual(rules.createMetricEvaluator().evaluate([rule({ enabled: false }), rule({ id: 'x', clauses: [] })], rows({ soc: 10, fc: 2 }), 100), []);
// State survives a restart (export/import) for conditions too.
const e1 = rules.createMetricEvaluator(); e1.evaluate([rule()], rows({ soc: 10, fc: 2 }), 100);
const e2 = rules.createMetricEvaluator(); e2.importState(e1.exportState());
assert.deepEqual(e2.evaluate([rule()], rows({ soc: 10, fc: 2 }), 130), [], 'already firing: not announced again');

// ── Message ──────────────────────────────────────────────────────────────
const hit = rules.createMetricEvaluator().evaluate([rule()], rows({ soc: 15, fc: 3 }), 100)[0];
let m = rules.conditionMessage(hit, 100);
assert.equal(m.title, 'Low battery, poor sun');
assert.equal(m.body, 'soc is below 20 % and fc is below 5 kWh. Now: soc 15 %, fc 3 kWh.');
assert.match(rules.conditionMessage({ ...hit, rule: rule({ join: 'any' }) }, 100).body, / or /);
assert.equal(rules.conditionMessage({ ...hit, transition: 'resolve' }, 100).title, 'Resolved: Low battery, poor sun');
assert.equal(rules.conditionMessage({ ...hit, rule: rule({ message: 'Charge up: {value}' }) }, 100).body, 'Charge up: soc 15 %, fc 3 kWh');
assert.match(rules.conditionMessage({ ...hit, transition: 'repeat' }, 100).title, /^Still active/);

// ── Saving ───────────────────────────────────────────────────────────────
store.saveChannels([{ id: 'c1', type: 'webhook', name: 'Hook', enabled: true, config: {} }]);
const base = { kind: 'condition', name: 'Combo', channels: ['c1'], join: 'all', clauses: [clause('soc', 'lt', '20', { hysteresis: 5 }), clause('fc', 'lt', 5)], notify_resolved: true };
const saved = normalizeRule(base, null);
assert.equal(saved.kind, 'condition'); assert.equal(saved.clauses.length, 2); assert.equal(saved.clauses[0].value, 20, 'numbers are stored as numbers');
assert.equal(saved.clauses[0].hysteresis, 5); assert.equal(saved.clauses[1].hysteresis, 0, 'no margin means 0'); assert.equal(normalizeRule({ ...base, clauses: [clause('mode', 'eq', 'on'), clause('soc', 'lt', 1)] }, null).clauses[0].hysteresis, undefined, 'a text comparison has no margin'); assert.equal(saved.join, 'all'); assert.equal(saved.notify_resolved, true);
assert.equal(normalizeRule({ ...base, join: 'any' }, null).join, 'any');
assert.equal(normalizeRule({ ...base, join: 'weird' }, null).join, 'all');
assert.equal(normalizeRule({ ...base, repeat_s: 60 }, null).repeat_s, 300, 'reminders are at least five minutes apart');
const bad = (o, re) => assert.throws(() => normalizeRule({ ...base, ...o }, null), re);
bad({ clauses: [clause('soc', 'lt', 20)] }, /at least two/);
bad({ clauses: [] }, /at least two/);
bad({ clauses: undefined }, /at least two/);
bad({ clauses: [1, 2, 3, 4].map(i => clause('m' + i, 'gt', i)) }, /at most 3/);
bad({ clauses: [clause('', 'lt', 1), clause('fc', 'lt', 1)] }, /Condition 1: pick a metric/);
bad({ clauses: [clause('a', 'lt', 1), clause('b', 'changes', '')] }, /Condition 2: pick a comparison/);
bad({ clauses: [clause('a', 'lt', 'abc'), clause('b', 'lt', 1)] }, /Condition 1: the value must be a number/);
bad({ clauses: [clause('a', 'stale', 0), clause('b', 'lt', 1)] }, /minutes must be more than 0/);
bad({ clauses: [clause('a', 'eq', ''), clause('b', 'lt', 1)] }, /enter the value/);
bad({ channels: [] }, /at least one channel/);
const textual = normalizeRule({ ...base, clauses: [clause('mode', 'eq', 'Battery'), clause('soc', 'lt', 20)] }, null);
assert.equal(textual.clauses[0].value, 'Battery');
console.log('ok - condition alert rules');
checks.done();
