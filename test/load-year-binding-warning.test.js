const assert = require('node:assert/strict');
const fs = require('node:fs');

// Real regression coverage for the generalized panel-27 solar/load
// binding-mismatch diagnostic (public/js/periodStat.mjs periodBindingWarning).
// Load with a promise-based dynamic import since the target is ESM.
(async () => {
  const { periodBindingWarning } = await import('../public/js/periodStat.mjs');

  // panel-27 case: label says "Load Energy This Year" but source query binds
  // the solar-yield metric -> must warn, never silently swap either way.
  const warning = periodBindingWarning('Load Energy This Year', 'daily_solar');
  assert.match(warning, /differs|verify|intentional/i, 'must surface a human-readable mismatch warning');
  assert.match(warning, /solar/i);

  // Reverse case: label says solar/yield but metric bound is load consumption.
  const reverseWarning = periodBindingWarning('Solar Yield This Month', 'daily_consumption');
  assert.match(reverseWarning, /load/i);

  // Consistent bindings must NOT warn (no false positives).
  assert.equal(periodBindingWarning('Load Energy This Year', 'daily_consumption'), '');
  assert.equal(periodBindingWarning('Solar Yield This Month', 'daily_solar'), '');
  assert.equal(periodBindingWarning('Battery Charge Today', 'daily_battery_charge'), '');

  // The editor must actually render this warning for period-sum stat cards,
  // never silently reassign the binding.
  const editorSrc = fs.readFileSync(require.resolve('../public/js/editor.js'), 'utf8');
  assert.match(editorSrc, /periodBindingWarning/);
  assert.match(editorSrc, /p2-binding-warning/);

  // periodReducer.js remains the canonical local-day-bucketed rollup source.
  assert.match(fs.readFileSync(require.resolve('../modules/periodReducer'), 'utf8'), /SQL_LOCAL_DAY/);

  console.log('load-year-binding-warning.test.js: PASS');
})().catch(e => { console.error(e); process.exit(1); });
