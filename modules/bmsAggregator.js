/**
 * BMS Bank Aggregator — combines multiple BMS devices into computed bank metrics.
 * Reads raw bms_<device>_<key> from latest_metrics, applies aggregation functions,
 * writes bank_<output> metrics.
 *
 * @typedef {Object} BankDevice
 * @property {string} name - BMS device name (matches bms_devices config)
 * @property {number} [capacity_override] - Manual Ah override
 *
 * @typedef {Object} BankFunction
 * @property {string} output - Output metric name (e.g. "bank_voltage")
 * @property {'sum'|'mean'|'min'|'max'|'weighted_soc'|'sum_weighted'|'last'|'or'|'and'} fn
 * @property {string} [source] - Raw metric key (e.g. "voltage") — legacy single-source
 * @property {Object<string,string>} [sources] - Per-device source map (e.g. {"300Ah":"voltage"})
 * @property {string} [weight_by] - Key for weight source (only weighted_soc / sum_weighted)
 *
 * @typedef {Object} Bank
 * @property {string} name
 * @property {boolean} enabled
 * @property {BankDevice[]} devices
 * @property {BankFunction[]} functions
 */

const { getConfig, getDb } = require('./database');
const { logger } = require('./logger');

// ---------------------------------------------------------------------------
// Read raw BMS metrics for a single device from latest_metrics
// ---------------------------------------------------------------------------

/**
 * Read all bms_<deviceName>_* metrics from latest_metrics.
 *
 * Prefix stripping: metrics are stored as 'bms_<deviceName>_<key>'.
 * The strip removes the prefix 'bms_<deviceName>_' from each metric name,
 * so that the returned keys are short form: "voltage", "current", etc.
 *
 * Guard: if a device name contains underscores or starts with 'bms_'
 * or 'bank_', the strip could be ambiguous. The UI should validate
 * device names to prevent this. If it happens, the strip uses exact
 * prefix match and logs a warning for any metric that doesn't match.
 *
 * @param {string} deviceName
 * @returns {Object.<string, {value: number, timestamp: number}>}
 */
function readLatestBmsMetrics(deviceName) {
  const db = getDb();
  const prefix = `bms_${deviceName}_`;
  const metrics = {};

  // Escape LIKE special chars: \ → \\, _ → \_, % → \%
  const escapedPrefix = prefix.replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%');
  const rows = db.prepare(
    `SELECT metric, value, timestamp FROM latest_metrics WHERE metric LIKE ? || '%' ESCAPE '\\'`
  ).all(escapedPrefix);

  for (const row of rows) {
    if (!row.metric.startsWith(prefix)) {
      logger.warn(`bmsAggregator: metric '${row.metric}' matched prefix '${prefix}' but strip is ambiguous — skipping`);
      continue;
    }
    const key = row.metric.slice(prefix.length);
    metrics[key] = { value: row.value, timestamp: row.timestamp };
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Freshness checks
// ---------------------------------------------------------------------------

/**
 * Determine whether a device's data is fresh.
 *
 * Uses the newest timestamp across ALL metrics for the device. This assumes
 * all metrics are updated together in a single poll cycle — if the newest
 * metric is fresh, the entire device is fresh. This holds for BMS bridge
 * polling (one HTTP request returns all metrics atomically).
 *
 * @param {Object<string,{value:number,timestamp:number}>} rawMetrics - from readLatestBmsMetrics
 * @param {number} stalenessThresholdSec - seconds before data is stale
 * @returns {boolean}
 */
function isDeviceFresh(rawMetrics, stalenessThresholdSec) {
  if (Object.keys(rawMetrics).length === 0) return false;
  const now = Math.floor(Date.now() / 1000);
  // Use the newest timestamp among all metrics for this device
  const newestTs = Math.max(...Object.values(rawMetrics).map(m => m.timestamp));
  return (now - newestTs) <= stalenessThresholdSec;
}

// ---------------------------------------------------------------------------
// Capacity resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a device's capacity in Ah.
 * Order: capacity_override → BMS design_capacity → null
 * @param {BankDevice} device
 * @param {Object<string,{value:number}>} rawMetrics
 * @returns {number|null}
 */
function resolveCapacity(device, rawMetrics) {
  if (device.capacity_override != null && device.capacity_override > 0) {
    return device.capacity_override;
  }
  const dc = rawMetrics['design_capacity'];
  if (dc && dc.value > 0) return dc.value;
  return null;
}

// ---------------------------------------------------------------------------
// Compute a single aggregation function
// ---------------------------------------------------------------------------

/**
 * Apply an aggregation function to a set of values.
 *
 * NOTE on sum_weighted: the plan formula is Σ(socᵢ × capacityᵢ) for remaining Ah.
 * BMS battery_level is 0–100 (percentage), so we divide by 100 before multiplying.
 * This is applied inside computeBankAggregates, not here — the caller normalises
 * SOC values before passing them.
 *
 * NOTE on last: returns the value from the device with the newest timestamp.
 * Timestamps are passed alongside values as a parallel array.
 *
 * @param {string} fn - function name
 * @param {number[]} values - one per device (may contain undefined for missing)
 * @param {number[]|null} weights - one per device (for weighted_soc / sum_weighted)
 * @param {number[]|null} timestamps - one per device (for 'last' function)
 * @returns {number|null}
 */
function computeFunction(fn, values, weights, timestamps) {
  // Filter out undefined/null values
  const valid = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null && !isNaN(values[i])) {
      valid.push(i);
    }
  }
  if (valid.length === 0) return null;

  switch (fn) {
    case 'sum': {
      let total = 0;
      for (const i of valid) total += values[i];
      return total;
    }
    case 'mean': {
      let total = 0;
      for (const i of valid) total += values[i];
      return total / valid.length;
    }
    case 'min': {
      let minVal = Infinity;
      for (const i of valid) minVal = Math.min(minVal, values[i]);
      return minVal;
    }
    case 'max': {
      let maxVal = -Infinity;
      for (const i of valid) maxVal = Math.max(maxVal, values[i]);
      return maxVal;
    }
    case 'weighted_soc': {
      // Σ(socᵢ × capacityᵢ) / Σ(capacityᵢ)
      // soc is percentage (0-100), but it cancels out in numerator/denominator
      if (!weights) return null;
      let num = 0, den = 0;
      for (const i of valid) {
        if (weights[i] == null || weights[i] <= 0) continue;
        num += values[i] * weights[i];
        den += weights[i];
      }
      return den > 0 ? num / den : null;
    }
    case 'sum_weighted': {
      // Σ(valueᵢ × weightᵢ)
      // Caller has already normalised SOC (÷100) before calling
      if (!weights) return null;
      let total = 0;
      for (const i of valid) {
        if (weights[i] == null || weights[i] <= 0) continue;
        total += values[i] * weights[i];
      }
      return total;
    }
    case 'last': {
      // Value from device with newest timestamp
      if (!timestamps) return values[valid[0]];
      let bestIdx = valid[0];
      for (const i of valid) {
        if (timestamps[i] != null && (timestamps[bestIdx] == null || timestamps[i] > timestamps[bestIdx])) {
          bestIdx = i;
        }
      }
      return values[bestIdx];
    }
    // Boolean functions — UI: hidden in v1, implemented for future use
    case 'or': {
      for (const i of valid) if (values[i] > 0) return 1;
      return 0;
    }
    case 'and': {
      for (const i of valid) if (values[i] === 0) return 0;
      return 1;
    }
    default:
      logger.warn(`bmsAggregator: unknown function '${fn}'`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// Main aggregation entry point
// ---------------------------------------------------------------------------

// Resolve per-device source key (supports both legacy fn.source and new fn.sources map)
function resolveSource(fn, deviceName) {
  if (fn.sources && typeof fn.sources === 'object') {
    return fn.sources[deviceName] || Object.values(fn.sources)[0] || fn.source;
  }
  return fn.source;
}

/**
 * Compute all aggregate metrics for a bank. Called after every BMS poll cycle.
 *
 * @param {Bank} bank - bank config object
 * @param {number} pollIntervalSec - BMS poll interval in seconds (for staleness check)
 * @returns {Promise<void>}
 */
async function computeBankAggregates(bank, pollIntervalSec) {
  if (!bank.enabled) return;
  if (!bank.functions || bank.functions.length === 0) {
    logger.debug(`bmsAggregator: bank '${bank.name}' has no functions — skipping`);
    return;
  }
  if (!bank.devices || bank.devices.length === 0) {
    logger.warn(`bmsAggregator: bank '${bank.name}' has no devices — skipping`);
    return;
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stalenessThreshold = pollIntervalSec * 2;

  // 1. Read raw metrics for all devices, determine freshness
  const deviceData = {}; // { deviceName: { metrics: {...}, fresh: bool } }
  let freshCount = 0;

  for (const device of bank.devices) {
    const raw = readLatestBmsMetrics(device.name);
    const fresh = isDeviceFresh(raw, stalenessThreshold);
    deviceData[device.name] = { raw, fresh, device };
    if (fresh) freshCount++;
  }

  // 2. Publication threshold: ≥50% of devices must be fresh
  if (freshCount / bank.devices.length < 0.5) {
    logger.debug(`bmsAggregator: bank '${bank.name}' has ${freshCount}/${bank.devices.length} fresh — skipping (below 50% threshold)`);
    return;
  }

  // 3. Write companion metrics
  const safeBankName = bank.name.replace(/[^a-zA-Z0-9_]/g, '_');
  const companionOnline = `bank_${safeBankName}_devices_online`;
  const companionUpdate = `bank_${safeBankName}_last_update`;
  const oldestFreshTs = Math.min(
    ...Object.values(deviceData)
      .filter(d => d.fresh)
      .map(d => Math.max(...Object.values(d.raw).map(m => m.timestamp)))
  );

  const metricInsert = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value) VALUES (?, ?, ?)');
  const latestUpsert = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value, timestamp) VALUES (?, ?, ?)');
  const metricInsertText = db.prepare('INSERT OR IGNORE INTO metrics (timestamp, metric, value_text, value_type) VALUES (?, ?, ?, ?)');
  const latestUpsertText = db.prepare('INSERT OR REPLACE INTO latest_metrics (metric, value_text, value_type, timestamp) VALUES (?, ?, ?, ?)');

  const writeMetric = (metricName, rawValue) => {
    if (rawValue === null || rawValue === undefined) return;
    const num = parseFloat(rawValue);
    if (!isNaN(num) && num === Number(rawValue)) {
      metricInsert.run(now, metricName, num);
      latestUpsert.run(metricName, num, now);
    } else {
      const strVal = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue).trim();
      const lower = strVal.toLowerCase();
      const isBool = lower === 'on' || lower === 'off' || lower === 'true' || lower === 'false' || typeof rawValue === 'boolean';
      const type = isBool ? 'boolean' : 'string';
      const displayVal = isBool ? lower : strVal;
      metricInsertText.run(now, metricName, displayVal, type);
      latestUpsertText.run(metricName, displayVal, type, now);
    }
  };

  writeMetric(companionOnline, freshCount);
  writeMetric(companionUpdate, oldestFreshTs);

  // 4. Compute each function
  for (const fn of bank.functions) {
    try {
      // Gather values and timestamps from fresh devices
      const values = [];
      const timestamps = [];
      for (const device of bank.devices) {
        const d = deviceData[device.name];
        if (!d.fresh) {
          values.push(undefined);
          timestamps.push(undefined);
          continue;
        }
        const src = d.raw[resolveSource(fn, device.name)];
        values.push(src ? src.value : undefined);
        timestamps.push(src ? src.timestamp : undefined);
      }

      // Resolve weights if needed
      let weights = null;
      if (fn.fn === 'weighted_soc' || fn.fn === 'sum_weighted') {
        weights = [];
        let validCapacityCount = 0;
        for (const device of bank.devices) {
          const d = deviceData[device.name];
          if (!d.fresh) { weights.push(undefined); continue; }
          const cap = resolveCapacity(device, d.raw);
          if (cap == null) {
            logger.warn(`bmsAggregator: bank '${bank.name}' — device '${device.name}' has no capacity, excluded from ${fn.fn}(${fn.source})`);
            weights.push(undefined);
          } else {
            weights.push(cap);
            validCapacityCount++;
          }
        }
        if (validCapacityCount < 2) {
          logger.warn(`bmsAggregator: bank '${bank.name}' — only ${validCapacityCount} devices have valid capacity, skipping ${fn.fn}(${fn.source})`);
          continue;
        }
      }

      // For sum_weighted: BMS battery_level is 0–100%, divide by 100
      if (fn.fn === 'sum_weighted') {
        for (let i = 0; i < values.length; i++) {
          if (values[i] != null) values[i] = values[i] / 100;
        }
      }

      // Guard: sum on partial set — log warning
      if (fn.fn === 'sum' && freshCount < bank.devices.length) {
        logger.warn(`bmsAggregator: bank '${bank.name}' — sum(${fn.source}) on partial set (${freshCount}/${bank.devices.length} devices) — value undercounted`);
      }

      const result = computeFunction(fn.fn, values, weights, timestamps);
      if (result != null) {
        writeMetric(`bank_${fn.output}`, result);
        logger.debug(`bmsAggregator: bank '${bank.name}' — bank_${fn.output} = ${result.toFixed(2)}`);
      }
    } catch (err) {
      logger.error(`bmsAggregator: bank '${bank.name}' — error computing ${fn.fn}(${fn.source}): ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan cleanup — delete bank_* metrics no longer referenced by any bank
// ---------------------------------------------------------------------------

/**
 * Remove orphaned bank metrics from latest_metrics.
 * Call after saving new bms_banks config. Does NOT touch history (metrics table).
 * @param {Bank[]} oldBanks - snapshot before save
 * @param {Bank[]} newBanks - after save
 */
function cleanupOrphanedBankMetrics(oldBanks, newBanks) {
  const db = getDb();

  // Collect all expected metric names from new config
  const expected = new Set();
  for (const bank of newBanks) {
    const safeName = bank.name.replace(/[^a-zA-Z0-9_]/g, '_');
    for (const fn of (bank.functions || [])) {
      expected.add(`bank_${fn.output}`);
    }
    expected.add(`bank_${safeName}_devices_online`);
    expected.add(`bank_${safeName}_last_update`);
  }

  // Collect all old metric names
  const oldSet = new Set();
  for (const bank of oldBanks) {
    const safeName = bank.name.replace(/[^a-zA-Z0-9_]/g, '_');
    for (const fn of (bank.functions || [])) {
      oldSet.add(`bank_${fn.output}`);
    }
    oldSet.add(`bank_${safeName}_devices_online`);
    oldSet.add(`bank_${safeName}_last_update`);
  }

  // Delete any that existed before but are not in the new config
  for (const name of oldSet) {
    if (!expected.has(name)) {
      db.prepare('DELETE FROM latest_metrics WHERE metric = ?').run(name);
      logger.info(`bmsAggregator: cleaned up orphan bank metric '${name}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Available source keys for a device (for UI function dropdown)
// ---------------------------------------------------------------------------

/**
 * Common BMS metric keys — used as fallback when no data exists yet.
 * Matches keys reported by JBD/DALY BMS via aiobmsble bridge.
 */
const COMMON_BMS_KEYS = [
  'voltage', 'current', 'power', 'battery_level', 'temperature',
  'runtime', 'cycles', 'design_capacity', 'cycle_capacity',
  'delta_cell_voltage', 'max_cell_voltage', 'min_cell_voltage',
  'rssi', 'link_quality'
];

/**
 * List available source keys for a BMS device.
 * Falls back to COMMON_BMS_KEYS if no data exists yet (cold-start).
 * @param {string} deviceName
 * @returns {string[]}
 */
function getAvailableSourceKeys(deviceName) {
  const raw = readLatestBmsMetrics(deviceName);
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    logger.info(`bmsAggregator: no metrics found for '${deviceName}' — test connection or wait for next poll`);
    return [];
  }
  // Return all keys with their values, sorted alphabetically
  return keys
    .sort()
    .map(k => ({ key: k, value: raw[k].value }));
}

module.exports = {
  computeBankAggregates,
  computeFunction,
  readLatestBmsMetrics,
  resolveSource,
  resolveCapacity,
  isDeviceFresh,
  cleanupOrphanedBankMetrics,
  getAvailableSourceKeys,
  COMMON_BMS_KEYS
};
