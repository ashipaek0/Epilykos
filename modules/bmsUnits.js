'use strict';
/**
 * Units of the readings a battery (BMS) reports. The Bluetooth and wired readers
 * give plain numbers, so without a unit a card could only guess one from the
 * metric's name: "capacity" in Wh showed as kWh, and a bank's total of them as
 * 1,072 kWh instead of 1.07 kWh. With the unit stored, cards show a Wh reading
 * from 1000 up as kWh, and a bank's total keeps the unit of what it adds up.
 *
 * Only keys whose unit is certain are listed; anything else stays without one.
 * @module bmsUnits
 */
const BMS_KEY_UNITS = {
  voltage: 'V', current: 'A', power: 'W', battery_level: '%', temperature: '°C',
  cycle_charge: 'Ah',        // remaining charge
  design_capacity: 'Ah',     // nominal capacity
  cycle_capacity: 'Wh',      // stored energy
  delta_cell_voltage: 'V', max_cell_voltage: 'V', min_cell_voltage: 'V'
};

/** The unit a BMS reading key is in, or undefined when it has none or is not known. */
function unitOfBmsKey(key) {
  return Object.prototype.hasOwnProperty.call(BMS_KEY_UNITS, key) ? BMS_KEY_UNITS[key] : undefined;
}

/**
 * The unit of a bank's result: what the function adds up or averages keeps its
 * source's unit; a weighted charge level is a percentage; the remaining Ah of
 * sum_weighted is in Ah; on/off results have none.
 */
function unitOfBankFunction(fn) {
  if (!fn) return undefined;
  if (fn.fn === 'weighted_soc') return '%';
  if (fn.fn === 'sum_weighted') return 'Ah';
  if (fn.fn === 'or' || fn.fn === 'and') return undefined;
  // One source key for the bank, or a key per battery: the unit if they all agree.
  const keys = fn.source ? [fn.source] : Object.values(fn.sources || {});
  const units = new Set(keys.map(unitOfBmsKey));
  return units.size === 1 ? [...units][0] : undefined;
}

module.exports = { BMS_KEY_UNITS, unitOfBmsKey, unitOfBankFunction };
