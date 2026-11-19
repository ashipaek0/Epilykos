'use strict';
/**
 * Checks a Modbus register profile (profiles/*.json) before it is shipped.
 *
 * Pure: takes the parsed JSON, returns findings; no files, no network. Used by
 * `npm run check:profile` and by the test that keeps every shipped profile
 * clean. Findings are { level: 'error' | 'warn', where, message }. An error is
 * something the poller cannot use or will misread; a warning is something a
 * reviewer should look at (a guess, an odd scale, a missing unit).
 */

const CONNECTIONS = new Set(['rtu', 'tcp']);
const TYPES = { uint16: 1, int16: 1, uint32: 2, int32: 2, uint64: 4 };
const STATUSES = new Set(['verified', 'unverified', 'community']);
const FUNCTIONS = new Set(['holding', 'input']);
const WORD_ORDERS = new Set(['msw_first', 'lsw_first']);
// Units seen in the shipped profiles. An unlisted unit is a warning, not an error: a new device may need one.
const UNITS = new Set(['', 'V', 'A', 'W', 'kW', 'VA', 'kVA', 'var', 'Wh', 'kWh', 'Ah', 'Hz', '%', '°C', 'mV', 'mA', 'min', 'h', 's', 'ms', 'Ohm', 'kOhm', 'KΩ', 'kΩ', 'VAR', 'cycles']);
const METRIC_NAME = /^[a-z][a-z0-9_]*$/;

function isInt(n) { return Number.isInteger(n); }

/** @returns {{level: string, where: string, message: string}[]} */
function checkProfile(profile) {
  const out = [];
  const add = (level, where, message) => out.push({ level, where, message });

  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    add('error', 'profile', 'The file must hold one JSON object.');
    return out;
  }
  if (typeof profile.name !== 'string' || !profile.name.trim()) add('error', 'name', 'A profile needs a name, as people will see it in the list.');
  if (!CONNECTIONS.has(profile.connection)) add('error', 'connection', `connection must be "rtu" (RS-485) or "tcp" (Modbus-TCP), not ${JSON.stringify(profile.connection)}.`);
  if (!isInt(profile.defaultUnitId) || profile.defaultUnitId < 1 || profile.defaultUnitId > 247) add('error', 'defaultUnitId', 'defaultUnitId must be a whole number from 1 to 247.');
  if (profile.status !== undefined && !STATUSES.has(profile.status)) add('error', 'status', 'status, when given, must be "verified", "unverified" or "community".');
  if (profile.function !== undefined && !FUNCTIONS.has(profile.function)) add('error', 'function', 'function, when given, must be "holding" (function 03) or "input" (function 04).');
  if (profile.wordOrder !== undefined && !WORD_ORDERS.has(profile.wordOrder)) add('error', 'wordOrder', 'wordOrder, when given, must be "msw_first" (high word first) or "lsw_first".');
  if (profile.source !== undefined && (typeof profile.source !== 'string' || !profile.source.trim())) add('warn', 'source', 'source, when given, should say which document the registers came from.');

  const regs = profile.registers;
  if (!Array.isArray(regs) || regs.length === 0) { add('error', 'registers', 'registers must be a list with at least one entry.'); return out; }

  const metrics = new Map();
  const spans = [];   // { start, end, id }
  regs.forEach((r, i) => {
    const id = r && r.metric ? `registers[${i}] (${r.metric})` : `registers[${i}]`;
    if (!r || typeof r !== 'object') { add('error', id, 'Each register must be an object.'); return; }

    if (typeof r.metric !== 'string' || !METRIC_NAME.test(r.metric)) add('error', id, 'metric must be lower-case letters, digits and underscores, starting with a letter (for example pv_power).');
    else if (metrics.has(r.metric)) add('error', id, `metric "${r.metric}" is already used by ${metrics.get(r.metric)}; every metric name must be unique.`);
    else metrics.set(r.metric, id);

    const width = TYPES[r.type];
    if (!width) add('error', id, `type must be one of ${Object.keys(TYPES).join(', ')}, not ${JSON.stringify(r.type)}.`);
    if (!isInt(r.address) || r.address < 0 || r.address > 65535) add('error', id, 'address must be a whole number from 0 to 65535 (the register number as the vendor document gives it, not an offset).');
    else if (width) spans.push({ start: r.address, end: r.address + width - 1, id, fn: (r.function || profile.function) === 'input' ? 'input' : 'holding' });
    if (r.function !== undefined && !FUNCTIONS.has(r.function)) add('error', id, 'function must be "holding" or "input".');
    if (r.word_order !== undefined) {
      if (!WORD_ORDERS.has(r.word_order)) add('error', id, 'word_order must be "msw_first" or "lsw_first".');
      else if (width === 1) add('warn', id, 'word_order only matters for 32- and 64-bit values.');
    }

    if (typeof r.scale !== 'number' || !Number.isFinite(r.scale) || r.scale === 0) add('error', id, 'scale must be a non-zero number (for example 0.1 when the register holds tenths).');
    else if (Math.abs(r.scale) > 10000 || Math.abs(r.scale) < 0.0001) add('warn', id, `scale ${r.scale} is unusual. Check it against the document.`);

    if (typeof r.label !== 'string' || !r.label.trim()) add('error', id, 'label is the name people see; give every register one.');
    if (typeof r.unit !== 'string') add('error', id, 'unit must be text (use "" for none).');
    else if (!UNITS.has(r.unit)) add('warn', id, `unit "${r.unit}" is not one the app knows. Fine if it is right; otherwise check the spelling.`);
    for (const k of Object.keys(r)) if (!['metric', 'address', 'type', 'scale', 'unit', 'label', 'note', 'confidence', 'function', 'word_order'].includes(k)) add('warn', id, `"${k}" is not a field the poller reads.`);
  });

  // A 32/64-bit value covers the following registers; no other entry may sit inside it.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length && spans[j].start <= spans[i].end; j++) {
      if (spans[i].fn !== spans[j].fn) continue;   // holding and input registers are separate address spaces
      if (spans[i].start === spans[j].start && spans[i].end === spans[i].start && spans[j].end === spans[j].start) add('error', spans[j].id, `shares address ${spans[j].start} with ${spans[i].id}.`);
      else add('error', spans[j].id, `starts at ${spans[j].start}, inside ${spans[i].id} (registers ${spans[i].start} to ${spans[i].end}).`);
    }
  }
  return out;
}

module.exports = { checkProfile, TYPES, UNITS };
