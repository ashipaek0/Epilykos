/**
 * PVOutput Metric Mapper — converts Epilykos metrics to PVOutput status parameters.
 *
 * All timestamps formatted in the PVOutput system timezone (not UTC, not server-local).
 * Uses Intl.DateTimeFormat for timezone-aware date/time formatting (C1).
 *
 * @module pvoutput/mapper
 */

function formatStatusTimestamp(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    d: `${parts.year}${parts.month}${parts.day}`,
    t: `${parts.hour}:${parts.minute}`
  };
}

/**
 * Round minutes down to nearest 5-min interval for the PVOutput time slot.
 */
function roundToInterval(date) {
  const m = date.getMinutes();
  date.setMinutes(m - (m % 5), 0, 0);
  return date;
}

/**
 * Build an addstatus POST body from Epilykos metrics.
 * @param {object} metrics — flat { metric_name: value } from getCurrentMetrics()
 * @param {object} config — pvoutput_config JSON
 * @param {Date} date — timestamp for this status entry
 * @returns {object} URLSearchParams-compatible key-value pairs
 */
function buildStatusPayload(metrics, config, date = new Date()) {
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rounded = roundToInterval(new Date(date));
  const { d, t } = formatStatusTimestamp(rounded, tz);

  const payload = { d, t };
  const map = config.metric_map || {};

  // Energy generation — use cumulative mode (c1=1) by default
  const hasCumulative = map.v1 && metrics[map.v1] != null;
  const hasInstantPower = map.v2 && metrics[map.v2] != null;

  if (hasCumulative) {
    const raw = metrics[map.v1];
    payload.v1 = Math.round(map.v1_is_kwh ? raw * 1000 : raw);
    if (!config.net_mode) payload.c1 = config.c1_mode ?? 1;
  }
  if (hasInstantPower) {
    payload.v2 = Math.round(metrics[map.v2]);
  }

  // Consumption
  if (map.v3 && metrics[map.v3] != null) {
    payload.v3 = Math.round(map.v3_is_kwh ? metrics[map.v3] * 1000 : metrics[map.v3]);
  }
  if (map.v4 && metrics[map.v4] != null) {
    payload.v4 = Math.round(metrics[map.v4]);
  }

  // Temperature & voltage
  if (map.v5 && metrics[map.v5] != null) payload.v5 = +metrics[map.v5].toFixed(1);
  if (map.v6 && metrics[map.v6] != null) payload.v6 = +metrics[map.v6].toFixed(1);

  // Battery
  if (config.battery_enabled && map.b1 && metrics[map.b1] != null) {
    payload.b1 = Math.round(metrics[map.b1]);
    payload.b2 = deriveBatteryState(metrics, map);
  }

  // Net mode
  if (config.net_mode && !hasCumulative) {
    payload.n = 1;
  }

  // Extended data (donation only)
  if (config.donation_mode) {
    for (let i = 7; i <= 12; i++) {
      const m = map[`v${i}`];
      if (m && metrics[m] != null) payload[`v${i}`] = +metrics[m].toFixed(2);
    }
  }

  return payload;
}

function deriveBatteryState(metrics, map) {
  const soc = map.soc_metric ? metrics[map.soc_metric] : null;
  const power = map.b1 ? metrics[map.b1] : null;
  if (soc != null && soc >= 95) return 3;  // Full
  if (soc != null && soc <= 5) return 4;   // Flat
  if (power != null && power > 10) return 2;  // Charging
  if (power != null && power < -10) return 1; // Discharging
  return 0;  // Idle
}

/**
 * Validate payload against PVOutput constraints.
 * @param {object} payload
 * @param {number|null} systemSizeW — from config or getsystem cache
 * @returns {string[]} error messages (empty = valid)
 */
function validatePayload(payload, systemSizeW) {
  const errors = [];
  if (!payload.v1 && !payload.v2 && !payload.v3 && !payload.v4) {
    errors.push('No energy or power values to upload');
  }
  if (systemSizeW && payload.v2 && payload.v2 > systemSizeW * 1.5) {
    errors.push(`v2 power ${payload.v2}W > 150% of system size ${systemSizeW}W`);
  }
  if (payload.c1 && payload.n) {
    errors.push('c1 and n (net) cannot both be set');
  }
  if (payload.b2 != null && payload.b1 == null) {
    errors.push('b2 requires b1');
  }
  return errors;
}

module.exports = { formatStatusTimestamp, buildStatusPayload, validatePayload, deriveBatteryState };
