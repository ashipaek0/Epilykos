'use strict';
const checks = require('./_checks');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const REPO = path.join(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'phocos-gatt-')));
const { BleGattTransport, decodeBlocks } = require(path.join(REPO, 'modules/dongle/bleGatt'));
const profile = JSON.parse(fs.readFileSync(path.join(REPO, 'profiles/dongles/phocos-anygrid-ble.json')));
const block = (characteristic, bytes, id = characteristic === '2a01' ? 'identity_firmware' : characteristic === '2a02' ? 'identity_serial' : characteristic === '2a05' ? 'ratings' : `settings_${characteristic}`) => ({ id, service: '1810', characteristic, length: bytes });
const settingsProfile = {
  ...profile,
  blocks: [block('2a03', 20), block('2a04', 20), block('2a11', 20), block('2a12', 20),
    { ...block('2a01', 20), optional: true }, { ...block('2a02', 20), optional: true },
    { ...block('2a05', 20), optional: true }],
  settingBlocks: [block('2a0c', 20), block('2a0d', 20), { ...block('2a0e', 2), optional: true }]
};
(async () => {
  const ident = Buffer.alloc(20); ident.write('FW123456', 3); ident.write('BLE00025', 12);
  const serial = Buffer.alloc(20); serial.write('SERIAL-123', 0); serial.write('9', 18);
  const ratings = Buffer.alloc(20); [2, 3, 6, 7].forEach((index, i) => ratings.writeUInt16LE([2300, 500, 5000, 480][i], index * 2));
  const c = Buffer.alloc(20); c.writeUInt16LE(230, 0); c.writeUInt16LE(500, 2); c[4] = 80; c[5] = 40;
  c.writeUInt16LE(560, 6); c.writeUInt16LE(580, 8); c.writeUInt16LE(440, 10); c.writeUInt16LE(500, 12); c[16] = 1; c[17] = 2; c[18] = 3; c[19] = 2;
  const d = Buffer.alloc(20); d.writeUInt16LE((1 << 0) | (1 << 3) | (1 << 9), 0); d[2] = 6;
  d[5] = 1; d.writeUInt16LE(30, 6); d.writeUInt16LE(90, 8); d.writeUInt16LE(5840, 10); d.writeUInt16LE(60, 12); d[14] = 1; d.writeUInt16LE(120, 16);
  const e = Buffer.from([0xaa, 100, 0xbb]);
  const raws = [Buffer.alloc(20), Buffer.alloc(20), Buffer.alloc(20), Buffer.alloc(20), ident, serial, ratings];
  const decoded = decodeBlocks(settingsProfile, raws);
  assert.deepStrictEqual(decoded.identity, { firmware: 'FW123456', bleFirmware: 'BLE00025', serial: 'SERIAL-123', modelId: '9' });
  assert.deepStrictEqual(decoded.ratings, { outputVoltage: 230, outputFrequency: 50, outputPower: 5000, batteryVoltage: 48, rawWords: [0, 0, 2300, 500, 0, 0, 5000, 480, 0, 0] });

  const calls = [];
  const t = new BleGattTransport({ ble_address: '58:2b:0a:50:9f:83' }, settingsProfile, {
    read: async (_address, reqs) => { calls.push(reqs); return reqs.map(r => r.characteristic === '2a0c' ? c : r.characteristic === '2a0d' ? d : r.characteristic === '2a0e' ? e : r.characteristic === '2a02' ? serial : ratings); }
  });
  const result = await t.settings();
  assert.equal(result.available, true);
  assert.deepStrictEqual(result.values.output_voltage, { value: 230, unit: 'V', writable: true });
  assert.equal(result.values.input_range.label, 'UPS');
  assert.equal(result.values.record_fault_codes.value, true);
  assert.equal(result.values.restart_overtemperature.value, true);
  assert.equal(result.values.battery_equalization.value, true);
  assert.equal(result.values.output_mode.value, 6);
  assert.equal(result.values.output_mode.label, '2P2-120');
  assert.equal(result.values.discharge_current.value, 100);
  assert.equal(result.values.max_charging_current.value, 80, 'one-byte current must not merge utility byte');
  assert.equal(result.values.max_utility_charging_current.value, 40);
  assert.equal(result.values.equalization_voltage.value, 58.4);
  assert.equal(result.values.equalization_voltage.writable, false);
  assert.deepStrictEqual(result.capabilities.find(x=>x.id==='float_voltage') && [result.capabilities.find(x=>x.id==='float_voltage').min,result.capabilities.find(x=>x.id==='float_voltage').max],[48,64]);
  assert.deepStrictEqual(result.capabilities.find(x=>x.id==='output_voltage').allowed,[220,230,240]);
  assert.equal(result.raw.settings_2a0e, 'aa64bb');
  assert.equal(result.provenance.settings_2a0d.output_mode, 'app_confirmed');
  assert.ok(result.capabilities.some(x => x.id === 'output_voltage' && x.writable && !x.blockedReason));
  assert.equal(calls[0].length, 5);

  const withoutOptional = new BleGattTransport({ ble_address: '58:2b:0a:50:9f:83' }, settingsProfile, {
    read: async (_address, reqs) => reqs.map(r => r.characteristic === '2a0c' ? c : r.characteristic === '2a0d' ? d : r.characteristic === '2a02' ? serial : r.characteristic === '2a05' ? ratings : null)
  });
  const unavailable = await withoutOptional.settings();
  const dischargeCapability = unavailable.capabilities.find(item => item.id === 'discharge_current');
  assert.equal(unavailable.model.supported, true);
  assert.equal(unavailable.values.discharge_current, undefined);
  assert.equal(dischargeCapability.writable, false);
  assert.equal(dischargeCapability.blockedReason, 'Setting value unavailable');
  const unavailableWrites = [];
  withoutOptional.change = async (_address, args) => { unavailableWrites.push(args); return { ok: true, status: 'done' }; };
  assert.equal((await withoutOptional.changeSetting({ id: 'discharge_current', expected: 100, value: 90 })).status, 'refused');
  assert.equal(unavailableWrites.length, 0, 'unavailable setting is never dispatched');

  const optionalShort = new BleGattTransport({ ble_address: '58:2b:0a:50:9f:83' }, settingsProfile, {
    read: async (_address, reqs) => reqs.map(r => r.characteristic === '2a0c' ? c : r.characteristic === '2a0d' ? d : r.characteristic === '2a0e' ? Buffer.from([0, 99]) : r.characteristic === '2a02' ? serial : ratings)
  });
  assert.equal((await optionalShort.settings()).values.discharge_current.value, 99);
  const missingRequired = new BleGattTransport({ ble_address: '58:2b:0a:50:9f:83' }, settingsProfile, {
    read: async () => [null, d, null]
  });
  await assert.rejects(missingRequired.settings(), /required block unavailable/);
  const incomplete = new BleGattTransport({ ble_address: '58:2b:0a:50:9f:83' }, settingsProfile, {
    read: async () => [Buffer.alloc(19), d, null]
  });
  await assert.rejects(incomplete.settings(), /length/);
  const forwarded = [];
  const writer = new BleGattTransport({ ble_address: '58:2b:0a:50:9f:83' }, profile, {
    read: async (_address, reqs) => reqs.map(r => r.characteristic === '2a0c' ? c : r.characteristic === '2a0d' ? d : r.characteristic === '2a0e' ? e : r.characteristic === '2a02' ? serial : ratings),
    change: async (_address, args) => { forwarded.push(args); return { ok:true,status:'done' }; }
  });
  for(const item of [{id:'max_charging_current',expected:80,value:40},{id:'output_frequency',expected:50,value:60},{id:'input_range',expected:1,value:0}]) {
    const result=await writer.changeSetting(item); assert.equal(result.status,'done',JSON.stringify(result));
  }
  assert.deepStrictEqual(forwarded.map(x=>[x.field,x.expected,x.value]), [['max_charging_current',80,40],['output_frequency',50,60],['input_range',1,0]]);
  const beforeInvalid=forwarded.length;
  for(const item of [{id:'max_charging_current',expected:80,value:121},{id:'output_frequency',expected:50,value:55},{id:'lcd_backlight',expected:0,value:1},{id:'output_mode',expected:0,value:1},{id:'output_voltage',expected:230,value:120}]) assert.equal((await writer.changeSetting(item)).status,'refused');
  assert.equal(forwarded.length,beforeInvalid,'JS rejects invalid writes before bridge call');
  const unknown = new BleGattTransport({ ble_address: 'AA:BB:CC:DD:EE:FF' }, profile, {change:async()=>{throw new Error('should not write');}});
  assert.equal((await unknown.changeSetting({id:'buzzer',expected:false,value:true})).status,'refused');
  const { spawnSync } = require('node:child_process');
  assert.equal(profile.fields.find(f=>f.name==='operating_mode').type,'string');
  const py=spawnSync('python3',['-c',"import json,sys;sys.path.insert(0,'modules/ble');from phocos_settings import catalogue;print(json.dumps(catalogue('9',48,5000,230)))"],{cwd:REPO,encoding:'utf8'});
  assert.equal(py.status,0,py.stderr);
  const helperCatalog=JSON.parse(py.stdout);
  for(const setting of profile.settings.filter(item=>item.writable)) assert.ok(helperCatalog[setting.field],`helper catalogue missing ${setting.field}`);
  assert.deepStrictEqual(profile.settings.filter(item=>item.writable).map(x=>x.field).sort(),Object.keys(helperCatalog).sort());
  const queueLog=[];
  const ordered=new BleGattTransport({ble_address:'58:2b:0a:50:9f:83'},profile,{
    read:async()=>{queueLog.push('read-start');await new Promise(resolve=>setTimeout(resolve,8));queueLog.push('read-end');return [c,d,e,serial,ratings];},
    change:async()=>{queueLog.push('change');return {ok:true,status:'done'};}
  });
  const secondInstance=new BleGattTransport({ble_address:'58:2b:0a:50:9f:83'},profile,{change:async()=>{queueLog.push('change2');return {ok:true,status:'done'};}});
  const pendingRead=ordered.settings();
  const pendingChange=secondInstance.changeSetting({id:'lcd_backlight',expected:false,value:true});
  await Promise.all([pendingRead,pendingChange]);
  assert.ok(queueLog.indexOf('read-end')<queueLog.indexOf('change2'),'same-address operations serialize across instances');
  const failedRead=new BleGattTransport({ble_address:'58:2b:0a:50:9f:83'},profile,{read:async()=>{throw new Error('fixture failure');}});
  await assert.rejects(failedRead.poll(),/fixture failure/);
  assert.equal((await ordered.changeSetting({id:'lcd_backlight',expected:false,value:true})).status,'done','queue recovers after rejection');
  console.log('ok - helper catalogue parity and cross-instance queue recovery');
  console.log('ok - typed allowlisted transactions and JS validation');
  console.log('ok - Phocos identity, ratings and typed settings decode');
  checks.done();
})().catch(error => { console.error(error); process.exit(1); });
