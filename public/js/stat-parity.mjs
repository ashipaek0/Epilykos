const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
export function selectLastNotNull(binding, values) {
  if (!binding || typeof binding.metric !== 'string' || !binding.metric || !own(values, binding.metric)) return {status:'no-data',value:null,reason:'missing-binding'};
  const value = values[binding.metric];
  if (value === null || value === undefined) return {status:'no-data',value:null,reason:'null-value'};
  if (typeof value !== 'number' || !Number.isFinite(value)) return {status:'no-data',value:null,reason:'invalid-value'};
  return {status:'data',value,reason:null};
}
export function resolveStat(binding, values, fallback) {
  const measured = selectLastNotNull(binding, values);
  if (measured.status === 'data') return {status:'data',value:measured.value,fallback:null};
  if (fallback && typeof fallback === 'object' && fallback.enabled === true && typeof fallback.value === 'number' && Number.isFinite(fallback.value) && typeof fallback.label === 'string' && fallback.label.trim()) return {status:'fallback',value:fallback.value,fallback:{value:fallback.value,label:fallback.label},measured:null};
  return measured;
}
export function formatStatValue(value, unit='', precision=0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const digits = Number.isInteger(precision) && precision >= 0 && precision <= 20 ? precision : 0;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}
export function evaluateThreshold(value, thresholds=[]) {
  let color = null;
  for (const threshold of thresholds) if (Number.isFinite(threshold?.value) && value >= threshold.value) color = threshold.color;
  return color;
}
export function statPresentation(value, thresholds=[], mode='value', fixedColor=null) {
  if (!Number.isFinite(value)) return {mode,color:null};
  return {mode,color:mode === 'fixed' ? fixedColor : evaluateThreshold(value, thresholds)};
}
export function normalizeStatConfig(config={}) {
  const reducer = config.reducer === 'period-sum' ? 'period-sum' : 'lastNotNull';
  return {...config, reducer, thresholds:Array.isArray(config.thresholds) ? config.thresholds.map(t=>({...t})) : [], sparkline:config.sparkline === 'none' ? 'none' : 'area'};
}
