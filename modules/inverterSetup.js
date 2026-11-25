'use strict';
const { logger } = require('./logger');

// Inverter readings saved without their prefix get it back (modules/inverterNames);
// with several inverters of one kind, roles use totals across them (modules/inverterTotals).
function updateInverterMetrics() {
  try { require('./inverterNames').repairSavedNames(); } catch (e) { logger.warn('Inverter name repair failed: ' + e.message); }
  try { require('./inverterTotals').updateTotals(); } catch (e) { logger.warn('Inverter totals failed: ' + e.message); }
}

module.exports = { updateInverterMetrics };
