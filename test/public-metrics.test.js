'use strict';
const checks = require('./_checks');
/**
 * Which readings a visitor may see (modules/publicMetrics.js): the setting's default (on for an install that exists, off for a new
 * one, never changed once set), the readings the dashboards shown to visitors use, and the filtering of a metric map and of the
 * dashboard state. The same rules over HTTP and the socket are in public-metrics-http.test.js.
 */
const assert = require('assert');
const pm = require('../modules/publicMetrics');

// ── The setting ─────────────────────────────────────────────────────────
const store = initial => { const m = new Map(Object.entries(initial)); return { getConfig: k => (m.has(k) ? m.get(k) : null), setConfig: (k, v) => m.set(k, v), m }; };
const noRows = { prepare: () => ({ get: () => undefined }) }, someRows = { prepare: () => ({ get: () => ({ 1: 1 }) }) };
assert.strictEqual(pm.shareAll(() => null), true, 'never set: sharing (an install from before the setting keeps its behaviour)');
assert.strictEqual(pm.shareAll(() => 'true'), true);
assert.strictEqual(pm.shareAll(() => 'false'), false);
assert.strictEqual(pm.shareAll(() => ''), true);

let s = store({});
assert.strictEqual(pm.ensureDefault({ ...s, getDb: () => noRows }), 'false', 'a brand-new install starts with sharing off');
assert.strictEqual(s.m.get('public_share_all_metrics'), 'false');
s = store({ setup_wizard_completed: 'true' });
assert.strictEqual(pm.ensureDefault({ ...s, getDb: () => noRows }), 'true', 'a set-up install keeps sharing');
s = store({ ha_devices: JSON.stringify([{ name: 'ha' }]) });
assert.strictEqual(pm.ensureDefault({ ...s, getDb: () => noRows }), 'true', 'one with a data source keeps sharing');
s = store({ ha_devices: '[]', mqtt_devices: '' });
assert.strictEqual(pm.ensureDefault({ ...s, getDb: () => someRows }), 'true', 'one with readings keeps sharing');
assert.strictEqual(pm.ensureDefault({ ...store({ ha_devices: '[]' }), getDb: () => noRows }), 'false', 'empty source lists are not a data source');
for (const v of ['true', 'false']) { s = store({ public_share_all_metrics: v, setup_wizard_completed: 'true' }); assert.strictEqual(pm.ensureDefault({ ...s, getDb: () => someRows }), v, `a value that is already set (${v}) is never changed`); }
console.log('ok - the setting: on for existing installs, off for new ones, never overwritten');

// ── What a visitor may read ─────────────────────────────────────────────
const layout = id => ({ id: 'b' + id, type: 'x', config: { metric: id + '_metric', series: [{ metric: id + '_series' }], metrics: { solar: id + '_role_token' }, title: 'Title ' + id } });
const config = { activeDashboard: 'main', dashboards: [{ id: 'main', layout: [layout('main')] }, { id: 'extra', layout: [layout('extra')] }, { id: 'private', layout: [layout('private')] }] };
const settings = { desktop_dashboard: 'main', mobile_dashboard: 'main', public_dashboards: '["extra"]', role_metrics: JSON.stringify({ solar: 'pv_power', load: 'load_power ' }),
  combined_metrics: JSON.stringify([{ name: 'main_metric', inputs: ['part_a', 'part_b'] }, { name: 'part_a', inputs: ['part_deep'] }, { name: 'other_total', inputs: ['secret_part'] }]) };
const allowed = pm.computeAllowed({ getConfig: k => (k in settings ? settings[k] : null), getDashboardConfig: () => config, forVisitor: require('../modules/dashboardVisibility').forVisitor });
for (const ok of ['main_metric', 'main_series', 'main_role_token', 'extra_metric', 'extra_series', 'pv_power', 'load_power', 'part_a', 'part_b', 'part_deep']) assert.ok(allowed.has(ok), `${ok} is readable`);
for (const no of ['private_metric', 'private_series', 'secret_part', 'other_total', 'fridge_power']) assert.ok(!allowed.has(no), `${no} is not`);
console.log('ok - visitors may read what the dashboards shown to them use, the role metrics and the parts of a combined metric on show');

const bare = pm.computeAllowed({ getConfig: () => null, getDashboardConfig: () => { throw new Error('no config'); }, forVisitor: () => { throw new Error('no config'); } });
assert.strictEqual(bare.size, 0, 'with nothing configured, nothing is readable (and nothing throws)');

// ── Filtering ───────────────────────────────────────────────────────────
const map = { a: { value: 1 }, b: { value: 2 }, c: { value: 3 } };
assert.deepStrictEqual(pm.filterMap(map, new Set(['a', 'c'])), { a: { value: 1 }, c: { value: 3 } });
assert.deepStrictEqual(pm.filterMap(null, new Set(['a'])), {});
const state = { current: { solar_kw: 2 }, metrics: map, breakdowns: { metrics: { a: { parts: [] }, b: { parts: [] } }, roles: { solar: { parts: ['x'] } } }, savings: { today: 5 } };
const copy = JSON.parse(JSON.stringify(state));
const f = pm.filterState(state, new Set(['a']));
assert.deepStrictEqual(Object.keys(f.metrics), ['a']);
assert.deepStrictEqual(Object.keys(f.breakdowns.metrics), ['a']);
assert.deepStrictEqual(f.breakdowns.roles, state.breakdowns.roles, 'the role totals are the overview, left as they are');
assert.deepStrictEqual(f.current, state.current); assert.deepStrictEqual(f.savings, state.savings);
assert.deepStrictEqual(state, copy, 'the state it was given is not changed');
assert.strictEqual(pm.filterState(null, new Set()), null);
assert.deepStrictEqual(pm.filterState({ x: 1 }, new Set()), { x: 1, metrics: {} });
console.log('ok - filtering a metric map and the dashboard state');

checks.done();
