const FAMILY_TYPES = Object.freeze({
  'stat-metric': 'stat-metric',
  'segmented-gauge': 'segmented-gauge',
  'multi-series-timeseries': 'multi-series-timeseries',
  'multi-series-bar-gauge': 'bar-stacked',
  'static-text': 'text-card',
  'string-state': 'text-card'
});
const FAMILY_NAMES = Object.freeze(Object.keys(FAMILY_TYPES));
const REGISTRY = Object.freeze(Object.fromEntries(FAMILY_NAMES.map(name => [name, Object.freeze({
  family: name, version: 1, componentType: FAMILY_TYPES[name],
  registration: Object.freeze({ renderer: FAMILY_TYPES[name], updater: 'expandFamilyBlockTypes', editor: 'resolveFamilyComponentType', settings: 'block-settings-modal' })
})])));
const DEFAULTS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map(name => [name, Object.freeze({ version: 1, bindings: Object.freeze({}), thresholds: Object.freeze([]), series: Object.freeze([]), axes: Object.freeze({}), reducers: Object.freeze({}), formulas: Object.freeze({}), fallback: Object.freeze({}), noData: Object.freeze({ status: 'no-data', value: null, reason: 'missing-binding' }) })])));
export const familyNames = FAMILY_NAMES;
export function getFamily(name) { return REGISTRY[name] || null; }
export function defaultConfig(name) {
  if (!REGISTRY[name]) throw new TypeError(`Unknown dashboard family: ${name}`);
  return JSON.parse(JSON.stringify(DEFAULTS[name]));
}
export function validateConfig(name, config) {
  const errors = [];
  if (!REGISTRY[name]) errors.push('unknown-family');
  if (!config || typeof config !== 'object' || Array.isArray(config)) errors.push('config-must-be-object');
  else {
    if (config.version !== 1) errors.push('unsupported-version');
    for (const key of ['bindings', 'axes', 'reducers', 'formulas', 'fallback', 'noData']) {
      if (config[key] !== undefined && (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key]))) errors.push(`${key}-must-be-object`);
    }
    for (const key of ['thresholds', 'series']) {
      if (config[key] !== undefined && !Array.isArray(config[key])) errors.push(`${key}-must-be-array`);
    }
  }
  return { valid: errors.length === 0, errors };
}
export function resolveBinding(binding, values) {
  if (!binding || typeof binding.metric !== 'string' || !binding.metric || !values || !Object.prototype.hasOwnProperty.call(values, binding.metric)) return { status: 'no-data', value: null, reason: 'missing-binding' };
  const value = values[binding.metric];
  if (value === null || value === undefined) return { status: 'no-data', value: null, reason: 'null-value' };
  return { status: 'data', value, reason: null };
}
