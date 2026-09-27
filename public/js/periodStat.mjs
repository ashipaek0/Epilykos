/**
 * Client-side counterpart to modules/periodReducer.js's financialValue —
 * duplicated (not shared) because public/js/*.mjs is pure ESM and
 * modules/*.js is CommonJS with no browser bundling step in this repo.
 * Keep both in sync; formulas are covered server-side by
 * test/financial-formula-parity.test.js.
 */
export const PERIOD_HISTORY_METRICS = Object.freeze([
  'daily_consumption', 'daily_solar', 'daily_battery_charge',
  'daily_battery_discharge', 'daily_grid_import', 'daily_grid_export'
]);
export const PERIODS = Object.freeze(['today', 'month', 'year', 'since-install']);

export function financialValue(formula, sum, params = {}) {
  if (!Number.isFinite(sum) || sum < 0) return null;
  const { monthlyRate, yearlyOffset, yearlyRate, generatorOffset, generatorRate, roiBaseline } = params;
  if (formula === 'monthly-grid-savings') return sum * Number(monthlyRate);
  if (formula === 'yearly-grid-savings') return (sum + Number(yearlyOffset)) * Number(yearlyRate);
  if (formula === 'generator-savings' || formula === 'generator-roi') {
    const savings = (sum + Number(generatorOffset)) * Number(generatorRate);
    return formula === 'generator-roi' ? savings - Number(roiBaseline) : savings;
  }
  throw new Error(`Unsupported formula: ${formula}`);
}

export function formatCurrency(value, currency = '', precision = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const digits = Number.isInteger(precision) && precision >= 0 && precision <= 20 ? precision : 0;
  const body = value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency ? `${currency}${body}` : body;
}

/** Normalize a period-stat card's config with safe defaults (no personal/location defaults). */
/** Heuristic binding-mismatch diagnostic (Phase 5, generalizes the panel-27
 * solar/load crossed-binding case from the source Grafana export): if a
 * period-stat card's own label implies one energy role (solar/load) but the
 * configured historyMetric points at the other, warn — never auto-correct. */
export function periodBindingWarning(label, historyMetric) {
  const l = String(label || '').toLowerCase();
  const saysLoad = /\bload\b/.test(l);
  const saysSolar = /\b(solar|pv|yield|generation)\b/.test(l);
  if (saysLoad && !saysSolar && historyMetric === 'daily_solar') {
    return `Label mentions "load" but the bound metric is Solar Yield (daily_solar) — verify this binding is intentional.`;
  }
  if (saysSolar && !saysLoad && historyMetric === 'daily_consumption') {
    return `Label mentions solar/yield but the bound metric is Load Consumption (daily_consumption) — verify this binding is intentional.`;
  }
  return '';
}

export function normalizePeriodStatConfig(config = {}) {
  const c = config || {};
  return {
    label: String(c.label ?? ''),
    period: PERIODS.includes(c.period) ? c.period : 'today',
    historyMetric: PERIOD_HISTORY_METRICS.includes(c.historyMetric) ? c.historyMetric : '',
    unit: String(c.unit ?? ''),
    precision: Number.isInteger(c.precision) ? c.precision : 1,
    formula: ['monthly-grid-savings', 'yearly-grid-savings', 'generator-savings', 'generator-roi', ''].includes(c.formula) ? c.formula : '',
    currency: String(c.currency ?? ''),
    formulaParams: { ...(c.formulaParams || {}) }
  };
}
