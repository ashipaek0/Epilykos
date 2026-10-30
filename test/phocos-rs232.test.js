'use strict';
const checks = require('./_checks');
// Phocos Any-Grid RS-232 / RS-485 profile: CRC framing, reading each reply,
// and the profile's fields. Replies are built in the formats of Phocos's
// command document (2020-12-14), with their CRC, and read through the
// decoder in modules/rs232.js as it is.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.LOG_TO_FILE = 'false';
const phocos = require('../modules/rs232-decoders/phocos-ascii');
const profile = require('../profiles/rs232/phocos-anygrid-rs232.json');
const rs232 = require('../modules/rs232');

const src = fs.readFileSync(path.join(__dirname, '../modules/rs232.js'), 'utf8');
const start = src.indexOf('function decodeAsciiResponse'), end = src.indexOf('function decodeVedirectFrame');
assert.ok(start > 0 && end > start);
const decodeAsciiResponse = new Function(src.slice(start, end) + '; return decodeAsciiResponse;')();
const cmdOf = name => profile.commands.find(c => c.name === name);
// What the poller does with a reply: check the CRC, then read the fields.
const read = (name, text, mappings = null) => decodeAsciiResponse(Buffer.from('(' + phocos.unwrap(phocos.frameReply(text)) + '\r'), cmdOf(name), mappings);

// ── CRC and framing ─────────────────────────────────────────────────
const documentCrc = { QPGS0: '3FDA', QPGS1: '2FFB', QPGS2: '1F98', QPGS3: '0FB9', QPGS4: '7F5E', QPGS5: '6F7F', QPGS6: '5F1C', QPGS7: '4F3D', QPGS8: 'BED2', QPGS9: 'AEF3' };
for (const [cmd, crc] of Object.entries(documentCrc)) assert.equal(phocos.crc16(Buffer.from(cmd)).toString(16).toUpperCase().padStart(4, '0'), crc, cmd);
assert.equal(phocos.crc16(Buffer.from('QPIGS')), 0xb7a9, 'the Voltronic-family CRC');
assert.equal(phocos.crc16(Buffer.from('QPIRI')), 0xf854);
console.log('ok - the ten CRCs in the document are what the CRC function gives');

assert.equal(phocos.encodeQuery({ query: 'QPGS0' }).toString('hex'), '51504753303fda0d', 'QPGS0 3F DA CR');
assert.equal(phocos.encodeQuery({ query: 'QPIGS\r\n' }).toString('hex'), '5150494753b7a90d');
assert.equal(phocos.encodeQuery({}).length, 0);
const whole = phocos.frameReply('A B C');
assert.equal(phocos.isCompleteFrame(whole), true);
assert.equal(phocos.unwrap(whole), 'A B C');
for (let cut = 1; cut < whole.length; cut++) assert.equal(phocos.isCompleteFrame(whole.subarray(0, cut)), false, 'a reply cut at ' + cut);
const damaged = Buffer.from(whole); damaged[2] ^= 0x01;
assert.equal(phocos.isCompleteFrame(damaged), false);
assert.throws(() => phocos.unwrap(damaged), /CRC/);
assert.throws(() => phocos.unwrap(Buffer.from('NAK\r')), /incomplete|CRC/);
// A CRC byte that is a CR does not end the reply early: it only counts as complete once the CRC checks out.
let carriage;
for (let i = 0; i < 3000 && !carriage; i++) { const f = phocos.frameReply('X' + i); if (f.subarray(f.length - 3, f.length - 1).includes(0x0d) || phocos.crc16(f.subarray(0, f.length - 3)) >> 8 === 0x0d || (phocos.crc16(f.subarray(0, f.length - 3)) & 255) === 0x0d) carriage = f; }
assert.ok(carriage, 'found a reply whose plain CRC holds a CR');
assert.equal(phocos.isCompleteFrame(carriage), true, 'sent the adjusted way, it checks out');
assert.equal(phocos.isCompleteFrame(carriage.subarray(0, carriage.length - 1)), false);
const plain = Buffer.concat([carriage.subarray(0, carriage.length - 3), Buffer.from([phocos.crc16(carriage.subarray(0, carriage.length - 3)) >> 8, phocos.crc16(carriage.subarray(0, carriage.length - 3)) & 255, 0x0d])]);
assert.equal(phocos.isCompleteFrame(plain), true, 'and sent unadjusted it checks out too');
console.log('ok - requests carry the CRC; a damaged, cut or foreign reply is refused; both CRC conventions are accepted');

// ── Readings: QPIGS ─────────────────────────────────────────────────
const num = (out, want) => { for (const [k, v] of Object.entries(want)) assert.ok(typeof out[k] === 'number' && Math.abs(out[k] - v) < 1e-9, `${k}: got ${out[k]}, want ${v}`); };
// AAA.A BB.B CCC.C DD.D EEEE FFFF GGG HHH II.II JJJ KKK LLLL MM.M NNN.N OO.OO PPPPP b7..b0 QQ RR SSSSS b10b9b8 T UU VVVV
const live = read('QPIGS', '230.0 50.0 231.5 50.1 0450 0380 009 380 51.20 004 075 0035 07.6 120.5 51.18 00008 00010110 00 00 01230 010 0 00 0000');
num(live, { grid_voltage: 230, grid_frequency: 50, output_voltage: 231.5, output_frequency: 50.1, output_va: 450, output_power: 380, load_percent: 9, bus_voltage: 380, battery_voltage: 51.2, battery_charge_current: 4, battery_soc: 75, inverter_temp: 35, pv_current: 7.6, pv_voltage: 120.5, battery_scc_voltage: 51.18, battery_discharge_current: 8, pv_power: 1230 });
// status 00010110: b4 AC load on, b2 battery charging, b1 solar charging, b0 AC charging off; 010: powered on, not floating
num(live, { ac_load_on: 1, battery_charging: 1, solar_charging: 1, ac_charging: 0, float_charging: 0, unit_powered_on: 1 });
num(read('QPIGS', '230.0 50.0 231.5 50.1 0450 0380 009 380 54.00 000 100 0035 00.0 000.0 54.00 00000 00000001 00 00 00000 110 0 00 0000'), { ac_charging: 1, solar_charging: 0, battery_charging: 0, float_charging: 1, unit_powered_on: 1, pv_power: 0 });
console.log('ok - QPIGS: every measurement and the status bits');

// ── Readings: QPGS0 ─────────────────────────────────────────────────
// A B C DD EEE.E FF.FF GGG.G HH.HH IIII JJJJ KKK LL.L MMM NNN OOO.O PPP QQQQQ RRRRR SSS status T U VVV WWW XX YY.Y ZZZ
const unit = read('QPGS0', '0 92931901100123 L 00 230.0 50.00 230.0 50.00 0450 0380 009 51.2 004 075 120.5 004 00450 00380 009 10001010 0 2 060 080 30 07.6 008');
assert.equal(unit.serial_number, '92931901100123');
assert.equal(unit.operating_mode, 'L'); assert.equal(unit.operating_mode_label, 'Grid / line');
num(unit, { other_units_connected: 0, fault_code: 0, total_charging_current: 4, total_output_va: 450, total_output_power: 380, total_nominal_power_percent: 9, ac_output_mode: 0, charger_priority: 2, max_charging_current_set: 60, max_charging_current_possible: 80, max_ac_charging_current_set: 30 });
assert.equal(unit.fault_description, 'No fault'); assert.equal(unit.charger_priority_label, 'Solar and utility (SNU)'); assert.equal(unit.ac_output_mode_label, 'Single');
// status 10001010: b7 MPPT active, b4b3 = 01 voltage low, b2 = 0 AC input available, b1 = 1 AC output on
num(unit, { mppt_active: 1, battery_state_code: 1, ac_input_available: 1, ac_output_on: 1 }); assert.equal(unit.battery_state, 'Voltage low');
const faulty = read('QPGS0', '1 92931901100123 F 04 000.0 00.00 000.0 00.00 0000 0000 000 40.1 000 010 000.0 000 00000 00000 000 00003100 0 1 060 080 30 00.0 000');
assert.equal(faulty.operating_mode_label, 'Fault'); num(faulty, { fault_code: 4, other_units_connected: 1, ac_input_available: 0, battery_state_code: 3, ac_output_on: 0 });
assert.equal(faulty.fault_description, 'Battery voltage too low'); assert.equal(faulty.battery_state, 'Charging and discharging disabled by the BMS');
console.log('ok - QPGS0: serial, mode, fault, totals, set currents and status');

// All 29 fault codes of the document, and nothing else but 00.
const codes = { '01': 'Fan locked while inverter off', '02': 'Over-temperature', '03': 'Battery voltage too high', '04': 'Battery voltage too low', '05': 'AC output short-circuit', '06': 'AC output voltage too high', '07': 'AC output overload', '08': 'Internal bus voltage too high', '09': 'Internal bus soft-start failed', '10': 'PV over-current', '11': 'PV over-voltage', '12': 'Internal DC converter over-current', '13': 'Battery discharge over-current', '51': 'Over-current', '52': 'Internal bus voltage too low', '53': 'Inverter soft-start failed', '55': 'DC over-voltage at AC output', '57': 'Current sensor failed', '58': 'AC output voltage too low', '60': 'Reverse-current protection active', '71': 'Firmware version inconsistent', '72': 'Current sharing fault', '80': 'CAN communication fault', '81': 'Host loss', '82': 'Synchronization loss', '83': 'Battery voltage detected inconsistent', '84': 'AC input voltage/frequency inconsistent', '85': 'AC output current imbalance', '86': 'AC output mode inconsistent' };
const faultField = cmdOf('QPGS0').fields.find(f => f.metric === 'fault_description');
assert.deepEqual(faultField.lookup, { '00': 'No fault', ...codes });
assert.equal(Object.keys(codes).length, 29);
const unknown = read('QPGS0', '0 92931901100123 L 99 230.0 50.00 230.0 50.00 0450 0380 009 51.2 004 075 120.5 004 00450 00380 009 10001010 0 2 060 080 30 07.6 008');
assert.equal(unknown.fault_description, 'Unknown (99)', 'a code that is not in the table is still shown');
console.log('ok - all 29 fault codes of the document have their name');

// ── Settings, flags, firmware ───────────────────────────────────────
// AAA.A BB.B CCC.C DD.D EE.E FFFF GGGG HH.H II.I JJ.J KK.K LL.L M NN OOO P Q R S TT U V WW.W X Y ZZZ a bbb cc.c
const settings = read('QPIRI', '230.0 50.0 230.0 50.0 21.7 5000 5000 48.0 46.0 42.0 56.4 54.0 3 30 060 0 2 2 9 00 0 0 48.0 0 0 000 0 000 44.0');
num(settings, { rated_output_voltage: 230, rated_output_frequency: 50, rated_output_current: 21.7, rated_output_va: 5000, rated_output_power: 5000, rated_battery_voltage: 48, setting_recharge_voltage: 46, setting_disconnect_voltage: 42, setting_boost_voltage: 56.4, setting_float_voltage: 54, setting_battery_type: 3, setting_max_utility_charging_current: 30, setting_max_charging_current: 60, setting_input_range: 0, setting_output_priority: 2, setting_charger_priority: 2, setting_max_units: 9, setting_offgrid_switch_voltage: 48, setting_boost_duration: 0, setting_discharge_current: 0, setting_reconnect_voltage: 44 });
assert.equal(settings.setting_battery_type_label, 'Pylontech'); assert.equal(settings.setting_output_priority_label, 'SBU'); assert.equal(settings.setting_input_range_label, 'Appliances (APL)'); assert.equal(settings.setting_charger_priority_label, 'Solar and utility (SNU)');
const flags = read('QFLAG', 'EDEEEDEDE');   // a b c d e f g h i
num(flags, { setting_buzzer: 1, setting_overload_bypass: 0, setting_lcd_auto_return: 1, setting_restart_overload: 1, setting_restart_overtemperature: 0, setting_lcd_backlight: 1, setting_alarm_source_interrupted: 0, setting_record_fault_codes: 1 });
assert.equal(read('QVFW', 'VERFW:00006.11').firmware_version, '00006.11');
console.log('ok - QPIRI settings with labels, QFLAG switches and the firmware version');

// A mapped device reads only what it mapped, under its own names.
const mapped = read('QPIGS', '230.0 50.0 231.5 50.1 0450 0380 009 380 51.20 004 075 0035 07.6 120.5 51.18 00008 00010110 00 00 01230 010 0 00 0000', { my_soc: 'QPIGS:10', my_solar: 'QPIGS:102' });
assert.deepEqual(mapped, { my_soc: 75, my_solar: 1 });
console.log('ok - mappings pick fields by their command and index, derived fields too');

// ── Parallel units ──────────────────────────────────────────────────
// A B C DD EEE.E FF.FF GGG.G HH.HH IIII JJJJ KKK LL.L MMM NNN OOO.O PPP QQQQQ RRRRR SSS status T U VVV WWW XX YY.Y ZZZ
const second = read('QPGS2', '1 92931901100456 B 00 000.0 00.00 230.0 50.00 0450 0380 009 51.2 004 075 120.5 004 00900 00760 009 11100010 0 2 060 080 30 07.6 008');
assert.equal(second.unit2_serial_number, '92931901100456'); assert.equal(second.unit2_operating_mode_label, 'Off-grid / battery');
num(second, { unit2_fault_code: 0, unit2_grid_voltage: 0, unit2_output_voltage: 230, unit2_output_frequency: 50, unit2_output_va: 450, unit2_output_power: 380, unit2_load_percent: 9, unit2_battery_voltage: 51.2, unit2_battery_charge_current: 4, unit2_battery_soc: 75, unit2_pv_voltage: 120.5, unit2_pv_current: 7.6, unit2_battery_discharge_current: 8, unit2_mppt_active: 1, unit2_ac_charging: 1, unit2_solar_charging: 1, unit2_ac_input_available: 1, unit2_ac_output_on: 1 });
assert.equal(second.unit2_battery_state, 'Normal'); assert.equal(second.unit2_ac_output_mode, 'Single'); assert.equal(second.unit2_charger_priority, 'Solar and utility (SNU)');
assert.equal(second.unit1_serial_number, undefined, 'a unit reads under its own name');
// A unit that is not there answers with a zero serial number: nothing is read from it.
assert.deepEqual(read('QPGS4', '0 00000000000000 P 00 000.0 00.00 000.0 00.00 0000 0000 000 00.0 000 000 000.0 000 00000 00000 000 00000000 0 0 000 000 00 00.0 000'), {});
assert.deepEqual(read('QPGS9', '0 0 P 00'), {});
console.log('ok - paralleled units QPGS1 to QPGS9 read under their own names; an absent unit gives nothing');

// ── Every other command of the document ─────────────────────────────
assert.equal(read('QPI', 'PI30').family_id, 30);
assert.equal(read('QVFW3', 'VERFW:00004.20').display_firmware_version, '00004.20');
assert.equal(read('VERFW', 'VERFW:00001.05').ble_firmware_version, '00001.05');
assert.equal(read('QT', '20261030124503').unit_time, '2026-10-30 12:45:03');
assert.equal(read('QT', '2026103').unit_time, undefined, 'a time that is not 14 digits is not shown');
assert.equal(read('QMCHGCR', '010 020 030 040 050 060 070 080').available_max_charging_currents, '010, 020, 030, 040, 050, 060, 070, 080');
assert.equal(read('QMUCHGCR', '002 010 020 030').available_max_utility_charging_currents, '002, 010, 020, 030');
num(read('QBATCD', '101'), { battery_discharge_flag: 1, battery_standby_discharge_flag: 0, battery_charge_flag: 1 });
// AAA.A BB.B CCCC DD.D EE.E FF.F GG.G HH I J K L M N O P Q R S T U V WW.W X Y ZZZ
const defaults = read('QDI', '230.0 50.0 0030 42.0 54.0 56.4 46.0 60 0 2 2 3 0 0 1 1 0 1 1 0 1 0 48.0 0 0 000');
num(defaults, { default_output_voltage: 230, default_output_frequency: 50, default_max_utility_charging_current: 30, default_disconnect_voltage: 42, default_float_voltage: 54, default_boost_voltage: 56.4, default_recharge_voltage: 46, default_max_charging_current: 60, default_input_range: 0, default_output_priority: 2, default_charger_priority: 2, default_battery_type: 3, default_buzzer: 1, default_restart_overload: 1, default_restart_overtemperature: 1, default_lcd_backlight: 0, default_alarm_source_interrupted: 1, default_record_fault_codes: 1, default_overload_bypass: 0, default_lcd_auto_return: 1, default_ac_output_mode: 0, default_offgrid_switch_voltage: 48, default_boost_duration: 0 });
const more = read('QPIRI', '230.0 50.0 230.0 50.0 21.7 5000 5000 48.0 46.0 42.0 56.4 54.0 3 30 060 0 2 2 9 00 0 1 48.0 0 0 000 0 000 44.0');
num(more, { rated_input_voltage: 230, rated_input_frequency: 50, setting_ac_output_mode: 1 }); assert.equal(more.setting_unit_type, 'Grid-tied'); assert.equal(more.setting_topology, 'Transformerless'); assert.equal(more.setting_ac_output_mode_label, 'Parallel');
console.log('ok - family, firmware (main, display, Bluetooth), time, available currents, permission flags, defaults and the rest of QPIRI');

// ── Optional commands and back-off ──────────────────────────────────
{
  const unitCmd = cmdOf('QPGS3'), state = {};
  assert.equal(rs232.commandDue(unitCmd, 0, state, null), true, 'asked on the first poll');
  rs232.backOff(unitCmd, 0, state);
  assert.deepEqual([1, 10, 19].map(n => rs232.commandDue(unitCmd, n, state, null)), [false, false, false], 'not asked again for 20 polls when absent');
  assert.equal(rs232.commandDue(unitCmd, 20, state, null), true, 'then asked again');
  assert.equal(rs232.commandDue(cmdOf('QPIGS'), 5, { until: 99 }, null), true, 'the live readings never back off');
  const mappings = { grid_in: 'QPIGS:0', unit_two_w: 'QPGS2:9' };
  assert.equal(rs232.commandDue(cmdOf('QPGS2'), 0, {}, mappings), true, 'an optional command with a mapped field is asked');
  assert.equal(rs232.commandDue(cmdOf('QPGS3'), 0, {}, mappings), false, 'one with nothing mapped is not asked at all');
  assert.equal(rs232.commandDue(cmdOf('QVFW'), 0, {}, { x: 'QVFW3:0' }), false, 'QVFW is not QVFW3');
  assert.equal(rs232.commandDue(cmdOf('QVFW'), 0, {}, { x: 'QVFW:0' }), true);
  assert.equal(rs232.commandDue(cmdOf('QPIGS'), 3, {}, { x: 'QPGS2:9' }), true, 'QPIGS is asked whatever is mapped');
  assert.equal(rs232.commandDue({ name: 'X', optional: true, retry_every: 3 }, 2, (() => { const st = {}; rs232.backOff({ retry_every: 3 }, 0, st); return st; })(), null), false);
  console.log('ok - optional commands wait out a back-off and are skipped when none of their fields is mapped');
}

// The names a unit's own display and app use: CSO / SNU / OSO, USB / SUB / SBU, and all eight battery types.
{
  const label = (cmd, metric) => cmdOf(cmd).fields.find(f => f.metric === metric).lookup;
  assert.deepEqual(label('QPIRI', 'setting_charger_priority_label'), { 1: 'Solar first (CSO)', 2: 'Solar and utility (SNU)', 3: 'Only solar (OSO)' });
  assert.deepEqual(label('QPIRI', 'setting_output_priority_label'), { 0: 'USB', 1: 'SUB', 2: 'SBU' });
  assert.deepEqual(Object.values(label('QPIRI', 'setting_battery_type_label')), ['AGM', 'Flooded', 'User defined', 'Pylontech', 'BYD', 'WeCo', 'MODBUS RTU RS-485', 'Any-Cell']);
  assert.equal(read('QPIRI', '230.0 50.0 230.0 50.0 21.7 5000 5000 48.0 46.0 42.0 56.4 54.0 7 30 060 0 2 3 9 00 0 0 48.0 0 0 000 0 000 44.0').setting_battery_type_label, 'Any-Cell');
  assert.equal(read('QPIRI', '230.0 50.0 230.0 50.0 21.7 5000 5000 48.0 46.0 42.0 56.4 54.0 7 30 060 0 2 3 9 00 0 0 48.0 0 0 000 0 000 44.0').setting_charger_priority_label, 'Only solar (OSO)');
  console.log('ok - charger priority reads CSO / SNU / OSO and battery types BYD to Any-Cell, as on the unit');
}

// ── The profile ─────────────────────────────────────────────────────
assert.equal(profile.protocol, 'phocos-ascii'); assert.equal(profile.decoder, undefined, 'no decoder: the field list and mapping screens use the ASCII form');
assert.deepEqual(profile.defaults, { baud: 2400, dataBits: 8, stopBits: 1, parity: 'none' });
const names = profile.commands.map(c => c.name);
assert.deepEqual(names, ['QPIGS', 'QPGS0', 'QPGS1', 'QPGS2', 'QPGS3', 'QPGS4', 'QPGS5', 'QPGS6', 'QPGS7', 'QPGS8', 'QPGS9', 'QPIRI', 'QFLAG', 'QDI', 'QMCHGCR', 'QMUCHGCR', 'QBATCD', 'QT', 'QPI', 'QVFW', 'QVFW3', 'VERFW']);
assert.deepEqual(profile.call_order, names);
const seenMetrics = new Set();
for (const cmd of profile.commands) {
  const indexes = cmd.fields.map(f => f.index);
  assert.equal(new Set(indexes).size, indexes.length, `${cmd.name}: every field has its own index (its mapping key)`);
  for (const f of cmd.fields) { assert.ok(f.metric && f.label, `${cmd.name}:${f.index} has a name`); assert.ok(!seenMetrics.has(f.metric), `${f.metric} is named once`); seenMetrics.add(f.metric); assert.ok((f.source ?? f.index) <= 28, `${cmd.name}:${f.index} reads a token the reply has`); }
}
assert.deepEqual(profile.commands.filter(c => !c.optional).map(c => c.name), ['QPIGS', 'QPGS0'], 'only the live readings are asked of every unit; the rest is optional');
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) { const c = cmdOf('QPGS' + n); assert.equal(c.query, 'QPGS' + n); assert.equal(c.absentWhenZero, 1); assert.equal(c.retry_every, 20); assert.ok(c.fields.every(f => f.metric.startsWith(`unit${n}_`))); }
assert.deepEqual(Object.fromEntries(profile.commands.filter(c => c.every).map(c => [c.name, c.every])), { QPIRI: 20, QFLAG: 20, QDI: 100, QMCHGCR: 100, QMUCHGCR: 100, QBATCD: 5, QT: 100, QPI: 100, QVFW: 100, QVFW3: 100, VERFW: 100 });
assert.equal(cmdOf('VERFW').query, 'VERFW:', 'the BLE controller query carries its colon');
assert.equal(typeof rs232.commandDue, 'function');
assert.deepEqual([0, 1, 19, 20, 21, 40].map(n => rs232.commandDue({ every: 20 }, n)), [true, false, false, true, false, true]);
assert.ok([0, 1, 7, 99].every(n => rs232.commandDue({}, n)), 'a command with no "every" is asked every time');
rs232.loadRs232Profiles();
const loaded = rs232.availableProfiles.find(p => p.id === 'phocos-anygrid-rs232');
assert.ok(loaded && loaded.protocol === 'phocos-ascii' && loaded.commands.length === 22, 'the poller lists the profile');
console.log('ok - the profile: unique fields, 2400 8N1, settings asked now and then, listed by the poller');

// Old ASCII profiles read the same as before.
const oldScale = decodeAsciiResponse(Buffer.from('(230.1 50.0 1200\r'), { name: 'X', response: { prefix: '(', delimiter: ' ' }, fields: [{ index: 0, metric: 'v', scale: 1 }, { index: 1, metric: 'f' }, { index: 2, metric: 'p', scale: 0.5 }, { index: 5, metric: 'gone' }, { index: 0, metric: 'mode', type: 'mode-char' }] }, null);
assert.deepEqual(oldScale, { v: 230.1, f: 50, p: 600, mode: 230.1 });
console.log('ok - existing ASCII profiles read exactly as before');
checks.done();
