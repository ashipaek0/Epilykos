'use strict';
/**
 * Server-side validation for numeric settings. The forms enforce ranges in
 * the browser, but a direct API call could store nonsense (negative capacity,
 * NaN latitude, 1e309) that then flows into forecast and savings maths. Each
 * numeric key is checked here; an out-of-range or non-finite value is a 400.
 *
 * Only numeric keys are listed; everything else passes through unchanged.
 */
const NUMERIC = {
  solar_latitude: { min: -90, max: 90 },
  solar_longitude: { min: -180, max: 180 },
  solar_tilt: { min: 0, max: 90 },
  solar_azimuth: { min: -360, max: 360 },
  solar_capacity_kwp: { min: 0, max: 100000 },
  solar_loss_factor: { min: 0, max: 1 },
  savings_rate: { min: 0, max: 1000000 },
  energy_sell_price: { min: 0, max: 1000000 },
  battery_wear_cost: { min: 0, max: 1000000 },
  battery_capacity_kwh: { min: 0, max: 100000 },
  battery_min_soc: { min: 0, max: 100 },
  generator_price: { min: 0, max: 1000000 },
  all_time_pv_savings_override: { min: 0, max: 1e12 },
};

/**
 * Returns null when all present numeric keys are valid, or an error string.
 * Empty string / undefined is allowed (means "unset"); only a provided,
 * non-empty value is range-checked.
 */
function validateNumericConfig(body) {
  for (const [key, range] of Object.entries(NUMERIC)) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === '' || raw === null || raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${key} must be a number`;
    if (n < range.min || n > range.max) return `${key} must be between ${range.min} and ${range.max}`;
  }
  return null;
}

module.exports = { validateNumericConfig, NUMERIC };
