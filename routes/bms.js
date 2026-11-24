/**
 * Bluetooth and wired BMS routes (mounted at /api): scan and test a Bluetooth BMS, the Bluetooth adapter's status
 * and a generic scan, a wired (Modbus-RTU) BMS's fields and test, a battery bank's test, and each device's metrics
 * and freshness. Signed-in only.
 *
 * @module routes/bms
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { getConfig, queueMetricWrite } = require('../modules/database');
const { isAuthenticated } = require('../modules/sessionAuth');
const { testBmsWiredConnection, getBmsWiredFields } = require('../modules/bmsWired');

const router = express.Router();

// Bluetooth BMS — built-in (modules/ble.js), or a legacy bms-bridge sidecar
// when BMS_BRIDGE_URL is set (see modules/bms.js).
router.use('/bms', isAuthenticated);

router.get('/bms/scan', async (req, res) => {
  try {
    const { scanDevices } = require('../modules/bms');
    res.json(await scanDevices(req.query.force === '1'));
  } catch (err) {
    logger.warn(`BMS scan failed: ${err.message}`);
    res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
});

router.get('/bms/test', async (req, res) => {
  const address = req.query.address;
  if (!address) return res.status(400).json({ error: 'MAC address required' });
  try {
    const { readDevice } = require('../modules/bms');
    const data = await readDevice(String(address), String(req.query.type || ''));

    // Store test data in latest_metrics so getAvailableSourceKeys can find it
    try {
      const devices = JSON.parse(getConfig('bms_devices') || '[]');
      const device = devices.find(d => String(d.address || '').toUpperCase() === String(address).toUpperCase());
      if (device && device.name) {
        const now = Math.floor(Date.now() / 1000);
        for (const [key, val] of Object.entries(data)) {
          if (typeof val !== 'number' || isNaN(val)) continue;
          const safeName = `bms_${device.name}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');
          queueMetricWrite({ metric: safeName, value: val, timestamp: now });
        }
      }
    } catch (storeErr) {
      logger.warn('Failed to store BMS test data:', storeErr.message);
    }

    res.json(data);
  } catch (err) {
    logger.warn(`BMS test read failed for ${address}: ${err.message}`);
    res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
});

// Bluetooth adapter status + generic scan (inverter BLE dongles use this to
// pick an address; the BMS scan above only lists recognised BMS devices).
router.use('/bluetooth', isAuthenticated);

router.get('/bluetooth/status', async (req, res) => {
  const ble = require('../modules/ble');
  const legacy = (process.env.BMS_BRIDGE_URL || '').trim();
  const st = await ble.status();
  res.json({ ...st, legacy_bms_bridge: !!legacy });
});

router.get('/bluetooth/scan', async (req, res) => {
  try {
    const ble = require('../modules/ble');
    res.json(await ble.scan({ timeout: 8, all: true }));
  } catch (err) {
    logger.warn(`Bluetooth scan failed: ${err.message}`);
    const status = ['no_dbus', 'no_adapter', 'adapter_off', 'no_bluez', 'dbus_denied', 'restarting', 'start_failed'].includes(err.code) ? 503 : 502;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// BMS wired (Modbus-RTU serial) — test + fields
router.use('/bms-wired', isAuthenticated);

// List the metric descriptors (field/label/unit) for a wired BMS profile.
router.get('/bms-wired/fields/:profileId', async (req, res) => {
  try {
    const fields = await getBmsWiredFields(req.params.profileId);
    res.json(fields);
  } catch (e) {
    logger.error('BMS-wired fields error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Open a one-off connection and read registers (no DB write).
router.post('/bms-wired/test', async (req, res) => {
  const device = req.body;
  if (!device) return res.status(400).json({ error: 'No device config provided' });
  if (!device.serial_path) return res.status(400).json({ error: 'Serial path required' });
  if (!device.profile) return res.status(400).json({ error: 'Profile required' });
  try {
    const result = await testBmsWiredConnection(device);
    res.json(result);
  } catch (e) {
    logger.error('BMS-wired test error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// BMS bank aggregation — test endpoint
router.post('/bms/bank/test', async (req, res) => {
  const bank = req.body;
  if (!bank || !bank.devices || !bank.functions) {
    return res.status(400).json({ error: 'Bank config with devices and functions required' });
  }
  try {
    const { readLatestBmsMetrics, isDeviceFresh, resolveSource, resolveCapacity, computeFunction } = require('../modules/bmsAggregator');
    const { stalenessForName } = require('../modules/bmsInterval');
    const now = Math.floor(Date.now() / 1000);

    // Gather raw data and freshness per device
    const deviceStatuses = {};
    const deviceData = {};
    let freshCount = 0;
    for (const device of (bank.devices || [])) {
      const raw = readLatestBmsMetrics(device.name);
      const fresh = isDeviceFresh(raw, stalenessForName(device.name));
      const newestTs = Object.keys(raw).length > 0
        ? Math.max(...Object.values(raw).map(m => m.timestamp))
        : null;
      deviceData[device.name] = { raw, fresh, device };
      deviceStatuses[device.name] = {
        status: fresh ? 'fresh' : 'stale',
        age_s: newestTs ? now - newestTs : null
      };
      if (fresh) freshCount++;
    }

    const willPublish = (freshCount / (bank.devices.length || 1)) >= 0.5;
    const results = {};
    const warnings = [];

    // Compute each function (preview only — don't write)
    for (const fn of (bank.functions || [])) {
      try {
        const values = [];
        const timestamps = [];
        for (const device of bank.devices) {
          const d = deviceData[device.name];
          if (!d.fresh) { values.push(undefined); timestamps.push(undefined); continue; }
          const src = d.raw[resolveSource(fn, device.name)];
          values.push(src ? src.value : undefined);
          timestamps.push(src ? src.timestamp : undefined);
        }

        let weights = null;
        if (fn.fn === 'weighted_soc' || fn.fn === 'sum_weighted') {
          weights = [];
          let capCount = 0;
          for (const device of bank.devices) {
            const d = deviceData[device.name];
            if (!d.fresh) { weights.push(undefined); continue; }
            const cap = resolveCapacity(device, d.raw);
            if (cap == null) {
              warnings.push(`${device.name}: design_capacity not reported, excluded from ${fn.fn}`);
              weights.push(undefined);
            } else {
              weights.push(cap);
              capCount++;
            }
          }
          if (capCount < 2) {
            warnings.push(`${fn.fn}(${fn.source}): only ${capCount} devices have valid capacity — skipped`);
            continue;
          }
        }

        if (fn.fn === 'sum_weighted') {
          for (let i = 0; i < values.length; i++) {
            if (values[i] != null) values[i] = values[i] / 100;
          }
        }

        if (fn.fn === 'sum' && freshCount < bank.devices.length) {
          warnings.push(`sum(${fn.source}): partial set (${freshCount}/${bank.devices.length} devices) — value undercounted`);
        }

        const result = computeFunction(fn.fn, values, weights, timestamps);
        if (result != null) {
          results[`bank_${fn.output}`] = Math.round(result * 100) / 100;
        }
      } catch (err) {
        logger.error(`BMS bank compute error for ${fn.output}:`, err.message);
        warnings.push(`${fn.output}: computation failed`);
      }
    }

    res.json({
      results,
      devices: deviceStatuses,
      summary: {
        devices_total: bank.devices.length,
        devices_fresh: freshCount,
        will_publish: willPublish
      },
      warnings
    });
  } catch (err) {
    logger.error('BMS bank test error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// BMS device source keys — for function row dropdown in UI
router.get('/bms/device-metrics/:name', (req, res) => {
  const name = req.params.name;
  if (!name || name.length > 64) return res.status(400).json({ error: 'Invalid device name' });
  try {
    const { getAvailableSourceKeys } = require('../modules/bmsAggregator');
    const keys = getAvailableSourceKeys(name, { fallback: req.query.fallback === '1' });
    res.json(keys);
  } catch (err) {
    logger.error('BMS device-metrics error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// BMS device connection status — for live indicator dot in settings UI
router.get('/bms/device-status', (req, res) => {
  const rawName = req.query.name;
  const name = Array.isArray(rawName) ? rawName[0] : rawName;
  if (!name || name.length > 64) return res.status(400).json({ error: 'Invalid device name' });
  try {
    const { readLatestBmsMetrics, isDeviceFresh } = require('../modules/bmsAggregator');
    const raw = readLatestBmsMetrics(name);
    const connected = isDeviceFresh(raw, require('../modules/bmsInterval').stalenessForName(name));
    const newestTs = Object.keys(raw).length > 0
      ? Math.max(...Object.values(raw).map(m => m.timestamp))
      : null;
    res.json({
      name,
      connected,
      metricCount: Object.keys(raw).length,
      lastSeen: newestTs
    });
  } catch (err) {
    logger.error('BMS device-status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
