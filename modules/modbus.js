const ModbusRTU = require('modbus-serial');
const fs = require('fs');
const path = require('path');
const { getConfig, db } = require('./database');

let availableProfiles = [];

function loadProfiles() {
  const profilesDir = path.join(__dirname, '../profiles');
  if (!fs.existsSync(profilesDir)) {
    fs.mkdirSync(profilesDir, { recursive: true });
    return;
  }
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
  availableProfiles.length = 0;
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(profilesDir, file), 'utf8');
      const profile = JSON.parse(raw);
      availableProfiles.push({
        id: file.replace('.json', ''),
        name: profile.name || file,
        registers: profile.registers || []
      });
    } catch (e) { console.error(`Failed to parse profile ${file}:`, e.message); }
  }
  console.log(`Loaded ${availableProfiles.length} Modbus profile(s).`);
}

async function pollModbus() {
  const modbusDevices = JSON.parse(getConfig('modbus_devices') || '[]');
  if (!modbusDevices.length) return;

  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');

  for (const device of modbusDevices) {
    if (!device.enabled || !device.host || !device.profile) continue;
    const profile = availableProfiles.find(p => p.id === device.profile);
    if (!profile) {
      console.error(`Modbus profile '${device.profile}' not found.`);
      continue;
    }
    let client;
    try {
      client = new ModbusRTU();
      await client.connectTcp(device.host, { port: parseInt(device.port) || 502 });
      await client.setID(parseInt(device.unit) || 1);

      const results = {};
      const sorted = [...profile.registers].sort((a, b) => a.address - b.address);
      let i = 0;
      while (i < sorted.length) {
        const startAddr = sorted[i].address;
        let count = 0;
        while (i < sorted.length && sorted[i].address === startAddr + count && count < 32) { count++; i++; }
        try {
          const resp = await client.readHoldingRegisters(startAddr, count);
          for (let j = 0; j < resp.data.length; j++) {
            const reg = sorted[i - count + j];
            const raw = resp.data[j];
            const value = reg.scale ? raw * reg.scale : raw;
            results[reg.metric] = value;
          }
        } catch (err) { console.error(`Modbus read error at ${startAddr}:`, err.message); }
      }
      client.close();

      const now = Math.floor(Date.now() / 1000);
      for (const [metric, value] of Object.entries(results)) {
        metricInsert.run(now, metric, value);
        latestUpsert.run(metric, value, now);
      }
      console.log(`Modbus poll (${device.name || device.host}): ${Object.keys(results).length} metrics.`);
    } catch (err) {
      console.error(`Modbus poll error for ${device.name || device.host}:`, err.message);
      if (client) client.close();
    }
  }
}

async function testModbusConnection(device) {
  let client;
  try {
    client = new ModbusRTU();
    await client.connectTcp(device.host, { port: parseInt(device.port) || 502 });
    await client.setID(parseInt(device.unit) || 1);
    const resp = await client.readHoldingRegisters(256, 1); // common battery SOC address
    client.close();
    return { success: true, value: resp.data[0] };
  } catch (err) {
    if (client) client.close();
    throw err;
  }
}

module.exports = { loadProfiles, pollModbus, testModbusConnection, availableProfiles };
