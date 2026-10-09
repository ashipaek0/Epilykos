'use strict';

const ble = require('../ble');
const queues = new Map();
const models = new Map();
const availableSettings = new Map();

function serialized(address, operation) {
  const prior = queues.get(address) || Promise.resolve();
  const result = prior.then(operation, operation);
  const tail = result.catch(() => {});
  queues.set(address, tail);
  return result.finally(() => {
    if (queues.get(address) === tail) queues.delete(address);
  });
}

function wordsLE(buffer) {
  const words = [];
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) words.push(buffer.readUInt16LE(offset));
  return words;
}

function valueAt(data, reference) {
  const match = /^([A-Za-z0-9_]+)\[(\d+)\]$/.exec(String(reference));
  if (!match || !Array.isArray(data[match[1]])) return undefined;
  return data[match[1]][Number(match[2])];
}

function bytes(raw, start, end) {
  return raw.toString('ascii', start, end).replace(/\0+$/g, '').trim();
}

function decodeIdentity(raws, profile) {
  const byId = Object.fromEntries((profile.blocks || []).map((block, index) => [block.id, raws[index]]));
  const firmware = byId.identity_firmware;
  const serialModel = byId.identity_serial;
  const rating = byId.ratings;
  const result = {};
  if (firmware) result.firmware = { firmware: bytes(firmware, 3, 11), bleFirmware: bytes(firmware, 12, 20) };
  if (serialModel) result.serial = { serial: bytes(serialModel, 0, 18), modelId: bytes(serialModel, 18, 19) };
  if (rating) {
    const rawWords = wordsLE(rating);
    result.ratings = {
      outputVoltage: rawWords[2] / 10,
      outputFrequency: rawWords[3] / 10,
      outputPower: rawWords[6],
      batteryVoltage: rawWords[7] / 10,
      rawWords
    };
  }
  return result;
}

function decodeBlocks(profile, raws) {
  const data = {};
  (profile.blocks || []).forEach((block, index) => {
    const raw = raws[index];
    if (raw && block.length && raw.length !== block.length) throw new Error(`invalid ${block.id} payload length`);
    if (!raw) return;
    data[block.id] = wordsLE(raw);
    if (block.id === 'status') data.operating_mode = raw.toString('ascii', 12, 13);
  });
  const identity = decodeIdentity(raws, profile);
  data.identity = { ...(identity.firmware || {}), ...(identity.serial || {}) };
  if (identity.ratings) data.ratings = identity.ratings;
  data.raw = Object.fromEntries((profile.blocks || []).map((block, index) => [block.id, raws[index] ? Buffer.from(raws[index]).toString('hex') : null]));
  data.derived = {};
  for (const derived of profile.derived || []) {
    const refs = derived.sum || derived.product;
    if (!refs) continue;
    const values = refs.map(reference => valueAt(data, reference));
    if (!values.every(value => typeof value === 'number')) continue;
    data.derived[derived.name] = derived.sum
      ? values.reduce((sum, value) => sum + value, 0)
      : values.reduce((product, value) => product * value, 1);
  }
  return data;
}

const ENUMS = {
  input_range: { 0: 'APL', 1: 'UPS' },
  output_priority: { 0: 'USB', 1: 'SUB', 2: 'SBU' },
  charger_priority: { 1: 'Solar first (CSO)', 2: 'Solar and Utility (SNU)', 3: 'Only Solar (OSO)' },
  battery_type: { 0: 'AGM', 1: 'Flooded', 2: 'User defined', 3: 'Pylontech', 4: 'BYD', 5: 'WeCo', 6: 'MODBUS RTU RS-485', 7: 'Any-Cell' },
  output_mode: { 0: 'Single', 1: 'Parallel', 2: '3P1', 3: '3P2', 4: '3P3', 5: '2P1', 6: '2P2-120', 7: '2P2-180' }
};
const FLAGS = ['record_fault_codes', 'alarm_source_interrupted', 'lcd_backlight', 'restart_overtemperature', 'restart_overload', 'lcd_auto_return', 'solar_feed_grid', 'overload_bypass', 'buzzer', 'battery_equalization'];
const NUMERIC_SETTINGS = {
  ac_output_voltage: [0, 2, 1, 'V'], ac_output_frequency: [2, 2, 0.1, 'Hz'],
  max_total_charging_current: [4, 1, 1, 'A'], max_utility_charging_current: [5, 1, 1, 'A'],
  float_voltage: [6, 2, 0.1, 'V'], boost_voltage: [8, 2, 0.1, 'V'],
  low_voltage_disconnect: [10, 2, 0.1, 'V'], offgrid_to_grid_voltage: [12, 2, 0.1, 'V'],
  equalization_duration: [6, 2, 1, 'min'], equalization_interval: [8, 2, 1, 'days'],
  equalization_voltage: [10, 2, 0.01, 'V'], equalization_timeout: [12, 2, 1, 'min'],
  boost_charge_duration: [16, 2, 1, 'min']
};
function u16(raw, offset) { return raw.readUInt16LE(offset); }
function settingEntry(id, value, unit, label) { return { value, ...(unit ? { unit } : {}), ...(label ? { label } : {}), writable: false }; }

function decodeSettings(profile, blocks, raws, model) {
  const raw = Object.fromEntries(blocks.map((block, index) => [block.id, raws[index] ? Buffer.from(raws[index]).toString('hex') : null]));
  const byCharacteristic = Object.fromEntries(blocks.map((block, index) => [block.characteristic, raws[index]]));
  const values = {};
  const provenance = { settings_2a0c: {}, settings_2a0d: {}, settings_2a0e: {} };
  const c = byCharacteristic['2a0c'], d = byCharacteristic['2a0d'], e = byCharacteristic['2a0e'];
  if (c) {
    const numeric = { output_voltage:[0,2,1,'V'], output_frequency:[2,2,0.1,'Hz'], max_charging_current:[4,1,1,'A'], max_utility_charging_current:[5,1,1,'A'], float_voltage:[6,2,0.1,'V'], boost_voltage:[8,2,0.1,'V'], disconnect_voltage:[10,2,0.1,'V'], recharge_voltage:[12,2,0.1,'V'] };
    for (const [id,[offset,width,scale,unit]] of Object.entries(numeric)) { values[id]=settingEntry(id,(width===1?c[offset]:u16(c,offset))*scale,unit); provenance.settings_2a0c[id]='app_confirmed'; }
    for (const [id,offset] of [['input_range',16],['output_priority',17],['charger_priority',18],['battery_type',19]]) { const value=c[offset], label=ENUMS[id]?.[value]; values[id]={...settingEntry(id,value,'',label),known:label!==undefined}; provenance.settings_2a0c[id]='app_confirmed'; }
  }
  if (d) {
    const flags=u16(d,0); FLAGS.forEach((id,bit)=>{values[id]=settingEntry(id,Boolean(flags&(1<<bit)));provenance.settings_2a0d[id]='app_confirmed';});
    values.output_mode={...settingEntry('output_mode',d[2],'',ENUMS.output_mode[d[2]]),known:ENUMS.output_mode[d[2]]!==undefined};
    values.force_equalization=settingEntry('force_equalization',Boolean(d[14]));
    values.unresolved_boolean_byte_5={value:d[5],booleanValue:Boolean(d[5]),confidence:'unknown',writable:false};
    provenance.settings_2a0d.output_mode='app_confirmed'; provenance.settings_2a0d.force_equalization='app_byte_access_semantics_not_read_confirmed'; provenance.settings_2a0d.unresolved_boolean_byte_5='unknown_semantics';
    for(const [id,offset] of [['equalization_duration',6],['equalization_interval',8],['equalization_timeout',12],['boost_duration',16]]) { values[id]=settingEntry(id,u16(d,offset),''); provenance.settings_2a0d[id]='app_confirmed'; }
    values.equalization_voltage=settingEntry('equalization_voltage',u16(d,10)/100,'V'); provenance.settings_2a0d.equalization_voltage='app_confirmed_read_only';
  }
  if(e){values.discharge_current=settingEntry('discharge_current',e[1],'A');provenance.settings_2a0e.discharge_current='app_confirmed';}
  const knownModel=Boolean(model && model.supported);
  const capabilities=(profile.settings||[]).map(s=>{
    let setting={...s};
    if(model?.supported){
      const modelBounds={max_charging_current:[0,model.watts===6500?120:80],max_utility_charging_current:[0,model.watts===6500?120:80],float_voltage:[model.nominalVoltage,model.nominalVoltage+16],boost_voltage:[model.nominalVoltage,model.nominalVoltage+16],disconnect_voltage:[model.nominalVoltage===24?18.8:37.5,model.nominalVoltage===24?27:54],recharge_voltage:[model.nominalVoltage===24?22:44,model.nominalVoltage===24?28.5:57],discharge_current:[0,model.nominalVoltage===48?120:150]}[s.id];
      if(modelBounds)[setting.min,setting.max]=modelBounds;
      if(s.id==='output_voltage') setting.allowed=model.acVoltage===120?[110,120,127]:model.acVoltage===230?[220,230,240]:[];
    }
    const blockedReason=!knownModel?'Unknown or unsupported model/rating combination':s.writable!==true?(s.reason||'Setting is read-only or unsupported by the transaction backend'):values[s.id]==null?'Setting value unavailable':null;
    return {...setting,writable:s.writable===true&&knownModel&&values[s.id]!=null,blockedReason};
  });
  for(const cap of capabilities) if(values[cap.id]) values[cap.id].writable=cap.writable;
  return {available:Boolean(c&&d),values,raw,provenance,model:model||null,capabilities};
}
function modelFrom(raws, blocks) {
  const byId=Object.fromEntries(blocks.map((b,i)=>[b.id,raws[i]]));
  const serial=byId.identity_serial, rating=byId.ratings;
  if(!serial||!rating) return {supported:false,reason:'identity or ratings unavailable'};
  const modelId=bytes(serial,18,19), words=wordsLE(rating), acVoltage=words[2]/10, nominalVoltage=words[7]/10, watts=words[6];
  const supported=(modelId==='1'||modelId==='9')&&((nominalVoltage===24&&watts===3000)||(nominalVoltage===48&&(watts===5000||(modelId==='9'&&watts===6500))))&&[120,230].includes(acVoltage);
  return {modelId,nominalVoltage,watts,acVoltage,supported};
}

class BleGattTransport {
  constructor(instance, profile, deps = {}) {
    const address = String(instance.ble_address || instance.host || '').trim().toUpperCase();
    if (!ble.isValidAddress(address)) throw new Error('invalid Bluetooth address');
    if (!profile || !Array.isArray(profile.blocks) || !profile.blocks.length) throw new Error('profile has no Bluetooth blocks');
    this.address = address; this.profile = profile; this.read = deps.read || ble.gattRead; this.change = deps.change || ble.phocosGattChange;
  }
  _read(blocks) { return this.read(this.address, blocks.map(block => ({ service: block.service, characteristic: block.characteristic }))); }
  poll() {
    return serialized(this.address, async () => {
      const raws = await this._read(this.profile.blocks);
      const data = decodeBlocks(this.profile, raws);
      for (let i = 0; i < this.profile.blocks.length; i++) if (!raws[i] && !this.profile.blocks[i].optional) throw new Error(`required block unavailable: ${this.profile.blocks[i].id}`);
      if (!this.profile.blocks.some((block, i) => raws[i])) throw new Error('no data read from device');
      return data;
    });
  }
  settings() {
    return serialized(this.address, async () => {
      const blocks=[...this.profile.settingBlocks||[], ...this.profile.blocks.filter(b=>['identity_serial','ratings'].includes(b.id))];
      const raws=await this._read(blocks);
      for(let i=0;i<blocks.length;i++) {
        if(!raws[i]&&['2a0c','2a0d'].includes(blocks[i].characteristic)) throw new Error(`required block unavailable: ${blocks[i].id}`);
        if(raws[i]&&blocks[i].length&&(blocks[i].characteristic==='2a0e'?raws[i].length<blocks[i].length:raws[i].length!==blocks[i].length)) throw new Error(`invalid ${blocks[i].id} payload length`);
      }
      const model=modelFrom(raws,blocks); models.set(this.address,model);
      const result=decodeSettings(this.profile,blocks,raws,model);
      availableSettings.set(this.address,new Set(Object.keys(result.values)));
      return result;
    });
  }
  changeSetting({ id, expected, value }) {
    return serialized(this.address, async () => {
      let setting=(this.profile.settings||[]).find(item=>item.id===id);
      const refuse=reason=>({ok:false,status:'refused',reason});
      if(!setting||setting.writable!==true||typeof setting.field!=='string') return refuse(setting?.reason||'unsupported setting');
      const model=models.get(this.address);
      if(!model?.supported) return refuse('Unknown or unsupported model/rating combination; read settings identity first');
      const available=availableSettings.get(this.address);
      if(available&&!available.has(id)) return refuse('Setting value unavailable; read settings first');
      if(setting.type==='number') {
        const bounds={
          max_charging_current:[0,model.watts===6500?120:80], max_utility_charging_current:[0,model.watts===6500?120:80],
          float_voltage:[model.nominalVoltage,model.nominalVoltage+16], boost_voltage:[model.nominalVoltage,model.nominalVoltage+16],
          disconnect_voltage:[model.nominalVoltage===24?18.8:37.5,model.nominalVoltage===24?27:54],
          recharge_voltage:[model.nominalVoltage===24?22:44,model.nominalVoltage===24?28.5:57],
          discharge_current:[0,model.nominalVoltage===48?120:150]
        }[id];
        if(bounds){setting={...setting,min:bounds[0],max:bounds[1]};}
      }
      if(id==='output_voltage') setting={...setting,allowed:model.acVoltage===120?[110,120,127]:model.acVoltage===230?[220,230,240]:[]};
      const valid=v=>{
        if(setting.type==='boolean') return typeof v==='boolean';
        if(typeof v!=='number'||!Number.isFinite(v)) return false;
        if(setting.allowed&&!setting.allowed.includes(v)) return false;
        if(setting.min!==undefined&&(v<setting.min||v>setting.max)) return false;
        if(setting.step&&Math.abs(v/setting.step-Math.round(v/setting.step))>1e-8) return false;
        return true;
      };
      if(!valid(value)||!valid(expected)) return refuse('expected/value outside catalogue type or range');
      if(typeof this.change!=='function') return refuse('GATT transaction backend unavailable');
      try { return await this.change(this.address,{characteristic:setting.characteristic,field:setting.field,expected,value}); }
      catch(err) { if(err?.code==='timeout') return {ok:false,status:'sent_unverified',reason:'transaction timed out; write may have been sent'}; throw err; }
    });
  }
}
module.exports = { BleGattTransport, decodeBlocks, wordsLE };
