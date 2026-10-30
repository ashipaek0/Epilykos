'use strict';
const checks = require('./_checks');
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs');
const profile = require('../profiles/dongles/phocos-anygrid-ble.json');
const { BleGattTransport, decodeBlocks } = require('../modules/dongle/bleGatt');
const { dongleProfileEntities } = require('../modules/entityCatalog');
function fixture(watts = 8000, nominal = 48) {
  const live = Buffer.alloc(20), status = Buffer.alloc(13), pv1 = Buffer.alloc(16), pv2 = Buffer.alloc(16);
  live.writeUInt16LE(5000,16); live.writeUInt16LE(2,18); live.writeUInt16LE(1000,10);
  status.writeUInt16LE(12,4); status[12] = 66; status[8] = 1; status[10] = 1;
  pv1.writeUInt16LE(700,14); pv2.writeUInt16LE(600,14);
  const serial = Buffer.alloc(20); serial.write('SERIAL-123',0); serial[18] = 0x58; serial[19] = 0x39;
  const ratings = Buffer.alloc(16); ratings.writeUInt16LE(2300,4); ratings.writeUInt16LE(watts,12); ratings.writeUInt16LE(nominal * 10,14);
  const settings = Buffer.alloc(20); settings.writeUInt16LE(543,6); settings[17] = 2;
  const byId = {live, status, pv1, pv2, identity_serial:serial, ratings, settings_2a0c:settings, settings_flags:Buffer.alloc(18), settings_2a0e:Buffer.from([0,100])};
  const raws = profile.blocks.map(b => byId[b.id] || null);
  Object.defineProperty(raws, 'diagnostics', {value:[{serviceUuid:'actual-service',characteristicUuid:'actual-char',properties:['read'],status:'read',length:13}]});
  return raws;
}
(async () => {
  let raws = fixture();
  const data = decodeBlocks(profile, raws);
  assert.equal(data.identity.modelId, '9', 'byte18 is deliberately different');
  assert.equal(data.identity.model.readSupported, true);
  assert.equal(data.identity.model.writeSupported, true, '8 kW / 48 V can write, with the 5 kW limits');
  assert.equal(data.identity.model.watts, 8000);
  const unknown = decodeBlocks(profile, fixture(10000)).identity.model;
  assert.equal(unknown.readSupported, true); assert.equal(unknown.writeSupported, false, 'other ratings stay read-only');
  assert.equal(data.derived.battery_net_current,-10);
  assert.equal(data.derived.battery_net_power,-500);
  assert.equal(data.derived.battery_charging_power,100);
  assert.equal(data.derived.estimated_grid_power,-800,'negative export estimate is preserved');
  assert.equal(data.operating_mode_label,'Battery / off-grid');
  assert.equal(data.fault_bytes,'01000100');
  assert.equal(data.diagnostics.faults.appPackedWord,257);
  assert.match(data.diagnostics.faults.interpretation,/unverified/);
  assert.equal(data.diagnostics.reads[0].characteristicUuid,'actual-char');
  assert.equal(data.settings.float_voltage,54.3);
  assert.equal(data.settings.output_priority,2);
  assert.equal(data.settings.discharge_current,100);
  assert.equal(data.settings.force_equalization,undefined);
  const entities = dongleProfileEntities(profile);
  assert.equal(entities.find(e=>e.name==='estimated_grid_power').confidence,'estimated');
  assert.equal(entities.find(e=>e.name==='bus_voltage').confidence,'corroborated');
  assert.equal(entities.find(e=>e.name==='pv1_current').confidence,'inferred','PV current is battery-side in the Phocos document, so it stays inferred');
  assert.equal(entities.find(e=>e.name==='setting_float_voltage').writable,false);
  assert.equal(entities.find(e=>e.name==='rated_output_power').id,'ratings.outputPower');
  raws = fixture(); raws[profile.blocks.findIndex(b=>b.id==='status')] = null;
  assert.equal(decodeBlocks(profile,raws).derived.battery_net_power,undefined);
  assert.equal(decodeBlocks(profile,raws).derived.estimated_grid_power,undefined);
  raws = fixture(); raws[profile.blocks.findIndex(b=>b.id==='settings_2a0e')] = Buffer.from([0]);
  const shortOptional = decodeBlocks(profile,raws);
  assert.equal(shortOptional.derived.pv_power,1300);
  assert.equal(shortOptional.settings.discharge_current,undefined);
  assert.equal(shortOptional.diagnostics.omittedBlocks[0].reason,'invalid payload length');
  raws[profile.blocks.findIndex(b=>b.id==='live')] = Buffer.alloc(19);
  assert.throws(()=>decodeBlocks(profile,raws),/invalid live/);
  for (const nominal of [24,48]) {
    const p = profile;
    const data = fixture(nominal===24?3000:5000,nominal);
    const map = Object.fromEntries(p.blocks.map((b,i)=>[b.characteristic,data[i]]));
    map['2a0d'] = Buffer.alloc(20);
    map['2a05'] = Buffer.concat([map['2a05'],Buffer.alloc(4)]);
    const transport = new BleGattTransport({ble_address:'AA:BB:CC:DD:EE:01'},p,{read:async(_,reqs)=>reqs.map(r=>map[r.characteristic])});
    const settings = await transport.settings();
    assert.equal(settings.model.modelId,'9');
    assert.equal(settings.model.supported,true);
    const caps = Object.fromEntries(settings.capabilities.map(c=>[c.id,c]));
    assert.equal(caps.float_voltage.max,nominal===24?32:64);
    assert.deepEqual(caps.max_charging_current.allowed,[2,10,20,30,40,50,60,70,80]);
    assert.ok(!caps.discharge_current.allowed.includes(20));
    assert.equal(caps.battery_type.allowed.includes(7),nominal===48);
    const forwarded=[]; transport.change=async(_,v)=>{forwarded.push(v);return {status:'done'};};
    assert.equal((await transport.changeSetting({id:'max_charging_current',expected:50,value:21})).status,'refused');
    assert.equal((await transport.changeSetting({id:'discharge_current',expected:100,value:20})).status,'refused');
    assert.equal(forwarded.length,0);
    // Check independent JS and physical-writer catalogues stay aligned.
    const {spawnSync} = require('node:child_process');
    const py=spawnSync('python3',['-c',`import json,sys;sys.path.insert(0,'modules/ble');from phocos_settings import catalogue;print(json.dumps(catalogue('9',${nominal},${nominal===24?3000:5000},230)))`],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
    assert.equal(py.status,0,py.stderr);
    const backend=JSON.parse(py.stdout);
    for (const [id, cap] of Object.entries(caps).filter(([,c])=>c.writable)) {
      for (const key of ['min','max','allowed']) if (backend[id][key]!==undefined) assert.deepEqual(cap[key],backend[id][key],`${id}.${key}`);
    }
  }
  console.log('Phocos evidence: identity, signed metrics, 8 kW writes with 5 kW limits, read-only unknown ratings, diagnostics and model constraints');
  checks.done();
})().catch(e=>{console.error(e);process.exitCode=1;});
