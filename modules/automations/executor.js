'use strict';
/**
 * modules/automations/executor.js — sends one automation step to its device.
 *
 * Goes through the same code as a person's change (performAction for Tuya,
 * Home Assistant and MQTT; changeSetting for inverter and battery settings,
 * with its read-first, range, step and read-back checks), tagged
 * 'automation:<id>' in the change log. Automations skip the "Allow device
 * changes" switch and the Controls unlock by design; nothing else is skipped.
 */
const deviceActions = require('../deviceActions');
const deviceControls = require('../deviceControls');

/** Read an inverter or battery setting (live). */
async function readCurrent(entry) {
  const r = await deviceControls.readSetting(entry.device, entry.entity);
  if (r.error) return { error: r.error };
  let value = r.value !== undefined ? r.value : r.current;
  if (entry.kind === 'switch' && typeof value === 'string') value = value === 'on' ? true : value === 'off' ? false : value;
  return { value };
}

function specFor(entry, step) {
  const base = { source: entry.source, device: entry.device, entity: entry.entity };
  if (entry.source === 'ha') {
    if (step.op === 'set') return { ...base, action: entry.selectAction && entry.kind !== 'number' ? entry.selectAction : entry.setAction, params: { value: step.value } };
    return { ...base, action: `${entry.haDomain}.turn_${step.op}`, params: {} };
  }
  if (step.op === 'set') return { ...base, action: 'set', params: { value: step.value } };
  return { ...base, action: `turn_${step.op}`, params: entry.source === 'tuya' ? { value: step.op === 'on' } : {} };
}

/** @returns {Promise<{ ok: boolean, unchanged?: boolean, error?: string }>} */
async function send(entry, step, current, automation) {
  const logSource = `automation:${automation.id}`;
  if (entry.source === 'device') {
    const wanted = step.op === 'set' ? step.value : step.op === 'on';
    const value = entry.deviceKind === 'bms' && entry.kind === 'switch' ? (wanted ? 'on' : 'off') : wanted;
    const r = await deviceControls.changeSetting({ device: entry.device, setting: entry.entity, value,
      expected: current && current.known ? current.value : undefined }, null, { source: logSource, bypassSwitch: true });
    return r.success ? { ok: true, unchanged: !!r.unchanged } : { ok: false, error: r.error || 'The change failed' };
  }
  const r = await deviceActions.performAction(specFor(entry, step), { logSource, bypassSwitch: true });
  return r.status === 200 ? { ok: true } : { ok: false, error: (r.body && r.body.error) || `Failed (${r.status})` };
}

module.exports = { send, readCurrent, specFor };
