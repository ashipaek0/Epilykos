const schemas = {
  'stat-metric': ['binding.metric','label','reducer','unit','precision','min','max','colorMode','fixedColor','thresholds','sparkline','fallback.enabled','fallback.value','fallback.label','period','historyMetric','formula','currency','installDate','formulaParams'],
  'segmented-gauge': ['binding.metric','label','reducer','unit','min','max','segments','spacing','thresholds','markers','labels','endpoint','sparkline','fallback.enabled','fallback.value','fallback.label'],
  'string-state': ['binding.metric','label','colorMode','mappings'],
  'static-text': ['content']
};
const PERIODS = ['today','month','year','since-install'];
const PERIOD_HISTORY_METRICS = ['daily_consumption','daily_solar','daily_battery_charge','daily_battery_discharge','daily_grid_import','daily_grid_export'];
const FORMULAS = ['monthly-grid-savings','yearly-grid-savings','generator-savings','generator-roi',''];
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function normalizeFormulaParams(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('formulaParams must be an object');
  const out = copy(input);
  for (const key of ['monthlyRate','generatorCost','generatorCapacity']) {
    if (out[key] === '' || out[key] == null) delete out[key];
    else { out[key] = Number(out[key]); if (!Number.isFinite(out[key])) throw new Error(`${key} must be numeric`); }
  }
  return out;
}
export function phase2FamilyFields(type) { return [...(schemas[type] || [])]; }
export function normalizePhase2FamilyConfig(type, input = {}) {
  const src = input || {}, out = copy(src) || {};
  if (!schemas[type]) throw new Error(`Unsupported Phase-2 family: ${type}`);
  if (type === 'static-text') return { ...out, content: String(src.content ?? '') };
  if (type === 'string-state') {
    let mappings = src.mappings;
    if (typeof mappings === 'string') { try { mappings = JSON.parse(mappings || '[]'); } catch { mappings = []; } }
    return { ...out, binding: { ...copy(src.binding || {}), metric: String(src.binding?.metric ?? src.metric ?? '') }, label: String(src.label ?? ''), colorMode: src.colorMode === 'background' ? 'background' : 'value', mappings: Array.isArray(mappings) ? copy(mappings) : [] };
  }
  out.binding = { ...copy(src.binding || {}), metric: String(src.binding?.metric ?? src.metric ?? '') };
  out.label = String(src.label ?? ''); out.reducer = src.reducer === 'period-sum' ? 'period-sum' : 'lastNotNull'; out.unit = String(src.unit ?? '');
  for (const key of ['precision','min','max','segments','spacing']) if (src[key] != null && src[key] !== '') out[key] = Number(src[key]);
  if (type === 'stat-metric') {
    out.colorMode = ['value','background','fixed'].includes(src.colorMode) ? src.colorMode : 'value'; out.fixedColor = String(src.fixedColor ?? ''); out.sparkline = src.sparkline === 'none' ? 'none' : 'area';
    if (out.reducer === 'period-sum') {
      out.period = PERIODS.includes(src.period) ? src.period : 'today';
      out.historyMetric = PERIOD_HISTORY_METRICS.includes(src.historyMetric) ? src.historyMetric : '';
      out.formula = FORMULAS.includes(src.formula) ? src.formula : '';
      out.currency = String(src.currency ?? '');
      out.installDate = String(src.installDate ?? '');
      out.formulaParams = normalizeFormulaParams(src.formulaParams);
    } else { for (const key of ['period','historyMetric','formula','currency','installDate','formulaParams']) delete out[key]; }
  }
  else { out.markers = !!src.markers; out.labels = !!src.labels; out.endpoint = src.endpoint === 'none' ? 'none' : 'point'; out.sparkline = src.sparkline === 'none' ? 'none' : 'area'; }
  out.thresholds = Array.isArray(src.thresholds) ? copy(src.thresholds) : [];
  const fb = src.fallback || {};
  out.fallback = { ...copy(fb), enabled: !!fb.enabled, value: fb.enabled ? (fb.value ?? null) : null, label: String(fb.label ?? '') };
  return out;
}
export function applyPhase2FormValues(type, existing = {}, values = {}) {
  if (type === 'static-text') return { ...copy(existing || {}), content: String(values.content ?? '') };
  if (type === 'string-state') {
    let mappings;
    try { mappings = typeof values.mappings === 'string' ? JSON.parse(values.mappings || '[]') : copy(values.mappings ?? existing.mappings ?? []); } catch { throw new Error('Mappings must be valid JSON'); }
    if (!Array.isArray(mappings) || mappings.some(m => !m || typeof m !== 'object' || typeof m.value !== 'string' || typeof m.label !== 'string')) throw new Error('Mappings must be an array of value/label objects');
    const seen = new Set();
    for (const mapping of mappings) { const key = mapping.value.trim().toLocaleLowerCase(); if (seen.has(key)) throw new Error('Mapping source values must be unique (case-insensitive)'); seen.add(key); }
    return { ...normalizePhase2FamilyConfig(type, existing), binding: { ...copy(existing.binding || {}), metric: String(values['binding.metric'] ?? values.metric ?? existing.binding?.metric ?? '') }, label: String(values.label ?? existing.label ?? ''), colorMode: values.colorMode === 'background' ? 'background' : 'value', mappings };
  }
  let thresholds;
  try { thresholds = typeof values.thresholds === 'string' ? JSON.parse(values.thresholds || '[]') : copy(values.thresholds ?? existing.thresholds ?? []); }
  catch { throw new Error('Thresholds must be valid JSON'); }
  if (!Array.isArray(thresholds)) throw new Error('Thresholds must be a JSON array');
  const get = (name, old) => values[name] !== undefined ? values[name] : old;
  const bind = values['binding.metric'] ?? values.metric ?? existing.binding?.metric ?? existing.metric ?? '';
  const val = { ...normalizePhase2FamilyConfig(type, existing), ...values, binding:{ ...copy(existing.binding || {}), metric:String(bind) }, thresholds };
  val.reducer = (type === 'stat-metric' && get('reducer', existing.reducer) === 'period-sum') ? 'period-sum' : 'lastNotNull';
  if (type === 'stat-metric') {
    val.colorMode = ['value','background','fixed'].includes(values.colorMode) ? values.colorMode : normalizePhase2FamilyConfig(type, existing).colorMode;
    val.sparkline = ['area','none'].includes(values.sparkline) ? values.sparkline : normalizePhase2FamilyConfig(type, existing).sparkline;
    if (val.reducer === 'period-sum') {
      val.period = PERIODS.includes(get('period', existing.period)) ? get('period', existing.period) : 'today';
      val.historyMetric = PERIOD_HISTORY_METRICS.includes(get('historyMetric', existing.historyMetric)) ? get('historyMetric', existing.historyMetric) : '';
      val.formula = FORMULAS.includes(get('formula', existing.formula)) ? get('formula', existing.formula) : '';
      val.currency = String(get('currency', existing.currency) ?? '');
      val.installDate = String(get('installDate', existing.installDate) ?? '');
      const rawParams = get('formulaParams', existing.formulaParams);
      let formulaParams;
      try { formulaParams = typeof rawParams === 'string' ? JSON.parse(rawParams || '{}') : copy(rawParams ?? {}); }
      catch { throw new Error('formulaParams must be valid JSON'); }
      if (!formulaParams || typeof formulaParams !== 'object' || Array.isArray(formulaParams)) throw new Error('formulaParams must be a JSON object');
      val.formulaParams = normalizeFormulaParams({ ...existing.formulaParams, ...formulaParams });
      for (const key of ['monthlyRate','generatorCost','generatorCapacity']) if (formulaParams[key] === '') delete val.formulaParams[key];
    } else {
      delete val.period; delete val.historyMetric; delete val.formula; delete val.currency; delete val.formulaParams; delete val.installDate;
    }
  } else if (type === 'segmented-gauge') {
    val.endpoint = ['point','none'].includes(values.endpoint) ? values.endpoint : normalizePhase2FamilyConfig(type, existing).endpoint;
    val.sparkline = ['area','none'].includes(values.sparkline) ? values.sparkline : normalizePhase2FamilyConfig(type, existing).sparkline;
  }
  for (const k of ['precision','min','max','segments','spacing']) { const v=get(k, existing[k]); if (v === '' || v == null) delete val[k]; else { const n=Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be numeric`); val[k]=n; } }
  val.fallback = { ...copy(existing.fallback || {}), enabled: !!get('fallback.enabled', existing.fallback?.enabled), value: null, label:String(get('fallback.label',existing.fallback?.label) ?? '') };
  const fv=get('fallback.value',existing.fallback?.value); val.fallback.value = val.fallback.enabled && fv !== '' && fv != null ? Number(fv) : null;
  if (val.fallback.value !== null && !Number.isFinite(val.fallback.value)) throw new Error('fallback.value must be numeric');
  if (val.min != null && val.max != null && val.min >= val.max) throw new Error('min must be less than max');
  val.thresholds = val.thresholds.map(t => {
    const raw = t?.value ?? (type === 'stat-metric' ? t?.to : t?.from ?? t?.min);
    if (raw == null || String(raw).trim() === '' || !Number.isFinite(Number(raw))) throw new Error('Thresholds must have finite values');
    return { ...t, value: Number(raw) };
  });
  if (type === 'segmented-gauge' && val.thresholds.some((t,i,rows) => i && t.value < rows[i-1].value)) throw new Error('Gauge threshold ranges must be finite and ordered');
  for (const key of Object.keys(val)) if (key.includes('.') && schemas[type].includes(key)) delete val[key];
  if (type === 'segmented-gauge') { val.markers=!!get('markers',existing.markers); val.labels=!!get('labels',existing.labels); }
  return val;
}
