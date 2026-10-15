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
  if (serialModel) result.serial = { serial: bytes(serialModel, 0, 18), modelId: bytes(serialModel, 19, 20) };
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
  const originalRaws = raws;
  const readDiagnostics = raws.diagnostics || [];
  const omittedBlocks = [];
  raws = raws.slice();
  (profile.blocks || []).forEach((block, index) => {
    const raw = raws[index];
    if (raw && ((block.minimumLength && raw.length < block.minimumLength) || (block.length && raw.length !== block.length))) {
      if (!block.optional) throw new Error(`invalid ${block.id} payload length`);
      omittedBlocks.push({id:block.id, reason:'invalid payload length', length:raw.length});
      raws[index] = null;
      return;
    }
    if (!raw) return;
    data[block.id] = wordsLE(raw);
    if (block.id === 'status') data.operating_mode = raw.toString('ascii', 12, 13);
  });
  const identity = decodeIdentity(raws, profile);
  data.identity = { ...(identity.firmware || {}), ...(identity.serial || {}) };
  if (identity.ratings) data.ratings = identity.ratings;
  data.raw = Object.fromEntries((profile.blocks || []).map((block, index) => [block.id, originalRaws[index] ? Buffer.from(originalRaws[index]).toString('hex') : null]));
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
  if (profile.decoder === 'phocos-pswh') {
    const model = modelFrom(raws, profile.blocks);
    data.identity = { ...data.identity, model };
    data.operating_mode_label = MODES[data.operating_mode] || (data.operating_mode ? 'Unknown' : undefined);
    const settings = decodeSettings(profile, profile.blocks, raws, model);
    data.settings = Object.fromEntries(Object.entries(settings.values)
      .filter(([id]) => !['force_equalization', 'unresolved_boolean_byte_5'].includes(id))
      .map(([id, entry]) => [id, entry.value]));
    const voltage = valueAt(data, 'live[8]'), charge = valueAt(data, 'live[9]'), discharge = valueAt(data, 'status[2]');
    if ([voltage, charge, discharge].every(Number.isFinite)) {
      data.derived.battery_net_current = charge - discharge;
      data.derived.battery_net_power = voltage / 100 * (charge - discharge);
      data.derived.battery_charging_power = voltage / 100 * charge;
    }
    const output = valueAt(data, 'live[5]'), pv = data.derived.pv_power;
    if ([output, pv, data.derived.battery_net_power].every(Number.isFinite)) {
      // Estimate only: ignores conversion losses. Positive is grid import.
      data.derived.estimated_grid_power = output + data.derived.battery_net_power - pv;
    }
    const statusIndex = profile.blocks.findIndex(b => b.id === 'status');
    const status = raws[statusIndex];
    if (status && status.length >= 12) {
      data.fault_bytes = status.subarray(8, 12).toString('hex');
      data.app_fault_word = status.readUInt16LE(8) + (status.readUInt16LE(10) << 8);
    }
    data.diagnostics = {
      source: 'PhocosLink 2.1.4 static analysis', hardwareValidated: false,
      sampledAt: new Date().toISOString(), identity: data.identity,
      reads: readDiagnostics, omittedBlocks,
      layouts: profile.blocks.map((b, i) => ({ id: b.id, length: originalRaws[i]?.length ?? null })),
      fieldConfidence: Object.fromEntries(profile.fields.map(f => [f.name, f.confidence || 'app_confirmed'])),
      faults: { rawHex: data.fault_bytes ?? null, appPackedWord: data.app_fault_word ?? null,
        interpretation: 'unverified: app overlaps two words with an 8-bit shift' }
    };
  }
  return data;
}

const MODES = { P: 'Power on', S: 'Standby', L: 'Utility / grid', B: 'Battery / off-grid', F: 'Fault', H: 'Power saving', D: 'Shutdown', C: 'Charge', Y: 'Bypass', E: 'ECO' };

// Shared by capability display and JS write preflight; Python independently
// enforces the same profile before any physical write.
function modelSetting(setting, model) {
  const v = model.nominalVoltage;
  const currentValues = [2, ...Array.from({length: model.watts === 6500 ? 12 : 8}, (_, i) => (i + 1) * 10)];
  const dischargeValues = [0, ...Array.from({length: v === 48 ? 10 : 13}, (_, i) => 30 + i * 10)];
  const bounds = {
    max_charging_current: [2, model.watts === 6500 ? 120 : 80],
    max_utility_charging_current: [2, model.watts === 6500 ? 120 : 80],
    float_voltage: [v, v === 24 ? 32 : 64], boost_voltage: [v, v === 24 ? 32 : 64],
    disconnect_voltage: [v === 24 ? 18.8 : 37.5, v === 24 ? 27 : 54],
    recharge_voltage: [v === 24 ? 22 : 44, v === 24 ? 28.5 : 57],
    discharge_current: [0, v === 48 ? 120 : 150]
  }[setting.id];
  const result = { ...setting };
  if (bounds) [result.min, result.max] = bounds;
  if (['max_charging_current', 'max_utility_charging_current'].includes(setting.id)) result.allowed = currentValues;
  if (setting.id === 'discharge_current') result.allowed = dischargeValues;
  if (setting.id === 'battery_type') result.allowed = Array.from({length: v === 24 ? 7 : 8}, (_, i) => i);
  if (setting.id === 'output_voltage') result.allowed = model.acVoltage === 120 ? [110,120,127] : model.acVoltage === 230 ? [220,230,240] : [];
  return result;
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
    for (const [id,[offset,width,scale,unit]] of Object.entries(numeric)) { values[id]=settingEntry(id,(width===1?c[offset]:u16(c,offset))/(1/scale),unit); provenance.settings_2a0c[id]='app_confirmed'; }
    for (const [id,offset] of [['input_range',16],['output_priority',17],['charger_priority',18],['battery_type',19]]) { const value=c[offset], label=ENUMS[id]?.[value]; values[id]={...settingEntry(id,value,'',label),known:label!==undefined}; provenance.settings_2a0c[id]='app_confirmed'; }
  }
  if (d) {
    const flags=u16(d,0); FLAGS.forEach((id,bit)=>{values[id]=settingEntry(id,Boolean(flags&(1<<bit)));provenance.settings_2a0d[id]='app_confirmed';});
    values.output_mode={...settingEntry('output_mode',d[2],'',ENUMS.output_mode[d[2]]),known:ENUMS.output_mode[d[2]]!==undefined};
    values.force_equalization={rawByte:d[14], confidence:'unknown', writable:false};
    values.unresolved_boolean_byte_5={value:d[5],booleanValue:Boolean(d[5]),confidence:'unknown',writable:false};
    provenance.settings_2a0d.output_mode='app_confirmed'; provenance.settings_2a0d.force_equalization='app_byte_access_semantics_not_read_confirmed'; provenance.settings_2a0d.unresolved_boolean_byte_5='unknown_semantics';
    for(const [id,offset] of [['equalization_duration',6],['equalization_interval',8],['equalization_timeout',12],['boost_duration',16]]) { values[id]=settingEntry(id,u16(d,offset),''); provenance.settings_2a0d[id]='app_confirmed'; }
    values.equalization_voltage=settingEntry('equalization_voltage',u16(d,10)/100,'V'); provenance.settings_2a0d.equalization_voltage='app_confirmed_read_only';
  }
  if(e){values.discharge_current=settingEntry('discharge_current',e[1],'A');provenance.settings_2a0e.discharge_current='app_confirmed';}
  const knownModel=Boolean(model && model.supported);
  const capabilities=(profile.settings||[]).map(s=>{
    let setting={...s};
    if(model?.supported) setting = modelSetting(s, model);
    const blockedReason=!knownModel?(model?.readSupported?'No validated write profile for this model/rating; telemetry remains read-only':'Unknown or unsupported model/rating combination'):s.writable!==true?(s.reason||'Setting is read-only or unsupported by the transaction backend'):values[s.id]==null?'Setting value unavailable':null;
    return {...setting,writable:s.writable===true&&knownModel&&values[s.id]!=null,blockedReason};
  });
  for(const cap of capabilities) if(values[cap.id]) values[cap.id].writable=cap.writable;
  return {available:Boolean(c&&d),values,raw,provenance,model:model||null,capabilities};
}
function modelFrom(raws, blocks) {
  const byId=Object.fromEntries(blocks.map((b,i)=>[b.id,raws[i]]));
  const serial=byId.identity_serial, rating=byId.ratings;
  if(!serial||!rating) return {supported:false,readSupported:false,writeSupported:false,reason:'identity or ratings unavailable'};
  if (serial.length < 20 || rating.length < 16) return {supported:false, readSupported:false, writeSupported:false, reason:'short identity or ratings'};
  const modelId=bytes(serial,19,20), words=wordsLE(rating), acVoltage=words[2]/10, nominalVoltage=words[7]/10, watts=words[6];
  const supported=(modelId==='1'||modelId==='9')&&((nominalVoltage===24&&watts===3000)||(nominalVoltage===48&&(watts===5000||(modelId==='9'&&watts===6500))))&&[120,230].includes(acVoltage);
  return {modelId,nominalVoltage,watts,acVoltage,supported, writeSupported:supported,
    readSupported:[24,48].includes(nominalVoltage) && Number.isFinite(watts) && watts > 0 && [120,230].includes(acVoltage),
    ...(supported ? {} : {reason:'No validated writable profile for this model/rating combination'})};
}

class BleGattTransport {
  constructor(instance, profile, deps = {}) {
    const address = String(instance.ble_address || instance.host || '').trim().toUpperCase();
    if (!ble.isValidAddress(address)) throw new Error('invalid Bluetooth address');
    if (!profile || !Array.isArray(profile.blocks) || !profile.blocks.length) throw new Error('profile has no Bluetooth blocks');
    this.address = address; this.profile = profile; this.read = deps.read || ble.gattRead; this.change = deps.change || ble.phocosGattChange;
    // Blocks with "every": N (identity, ratings, settings) rarely change: read
    // them every Nth poll and reuse the last copy in between, so each poll on
    // a shared adapter stays short. A settings read or change re-reads them.
    this._polls = 0; this._cached = new Map(); this._refresh = true;
  }
  _read(blocks) { return this.read(this.address, blocks.map(block => ({ service: block.service, characteristic: block.characteristic, ...(block.optional ? {optional:true} : {}) }))); }
  async _pollRaws() {
    const blocks = this.profile.blocks;
    const due = blocks.map(b => !(b.every > 1) || this._refresh || !this._cached.has(b.id) || this._polls % b.every === 0);
    const wanted = blocks.filter((b, i) => due[i]);
    const fresh = wanted.length ? await this._read(wanted) : [];
    this._polls++; this._refresh = false;
    let k = 0;
    const raws = blocks.map((b, i) => {
      if (!due[i]) return this._cached.get(b.id);
      const raw = fresh[k++];
      if (b.every > 1) { if (raw) this._cached.set(b.id, raw); else this._cached.delete(b.id); }
      return raw;
    });
    Object.defineProperty(raws, 'diagnostics', { value: fresh.diagnostics || [] });
    return raws;
  }
  poll() {
    return serialized(this.address, async () => {
      const raws = await this._pollRaws();
      const data = decodeBlocks(this.profile, raws);
      for (let i = 0; i < this.profile.blocks.length; i++) if (!raws[i] && !this.profile.blocks[i].optional) throw new Error(`required block unavailable: ${this.profile.blocks[i].id}`);
      if (!this.profile.blocks.some((block, i) => raws[i])) throw new Error('no data read from device');
      return data;
    });
  }
  settings() {
    return serialized(this.address, async () => {
      this._refresh = true;   // the next poll reads identity and settings again
      const blocks=[...this.profile.settingBlocks||[], ...this.profile.blocks.filter(b=>['identity_serial','ratings'].includes(b.id))];
      const raws=await this._read(blocks);
      for(let i=0;i<blocks.length;i++) {
        if(!raws[i]&&['2a0c','2a0d'].includes(blocks[i].characteristic)) throw new Error(`required block unavailable: ${blocks[i].id}`);
        if(raws[i]&&((blocks[i].minimumLength&&raws[i].length<blocks[i].minimumLength)||(blocks[i].length&&(blocks[i].characteristic==='2a0e'?raws[i].length<blocks[i].length:raws[i].length!==blocks[i].length)))) throw new Error(`invalid ${blocks[i].id} payload length`);
      }
      const model=modelFrom(raws,blocks); models.set(this.address,model);
      const result=decodeSettings(this.profile,blocks,raws,model);
      availableSettings.set(this.address,new Set(Object.keys(result.values)));
      result.diagnostics = { reads: raws.diagnostics || [], hardwareValidated: false, model };
      return result;
    });
  }
  changeSetting({ id, expected, value }) {
    return serialized(this.address, async () => {
      this._refresh = true;
      let setting=(this.profile.settings||[]).find(item=>item.id===id);
      const refuse=reason=>({ok:false,status:'refused',reason});
      if(!setting||setting.writable!==true||typeof setting.field!=='string') return refuse(setting?.reason||'unsupported setting');
      const model=models.get(this.address);
      if(!model?.supported) return refuse(model?.readSupported ? 'No validated write profile for this model/rating; telemetry remains read-only' : 'Unknown or unsupported model/rating combination; read settings identity first');
      const available=availableSettings.get(this.address);
      if(available&&!available.has(id)) return refuse('Setting value unavailable; read settings first');
      setting = modelSetting(setting, model);
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
