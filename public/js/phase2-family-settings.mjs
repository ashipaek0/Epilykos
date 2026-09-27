const schemas = {
  'stat-metric': ['binding.metric','label','reducer','unit','precision','min','max','colorMode','fixedColor','thresholds','sparkline','fallback.enabled','fallback.value','fallback.label'],
  'segmented-gauge': ['binding.metric','label','reducer','unit','min','max','segments','spacing','thresholds','markers','labels','endpoint','sparkline','fallback.enabled','fallback.value','fallback.label'],
  'static-text': ['content']
};
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
export function phase2FamilyFields(type) { return [...(schemas[type] || [])]; }
export function normalizePhase2FamilyConfig(type, input = {}) {
  const src = input || {}, out = {};
  if (!schemas[type]) throw new Error(`Unsupported Phase-2 family: ${type}`);
  if (type === 'static-text') return { content: String(src.content ?? '') };
  out.binding = { metric: String(src.binding?.metric ?? src.metric ?? '') };
  out.label = String(src.label ?? ''); out.reducer = 'lastNotNull'; out.unit = String(src.unit ?? '');
  for (const key of ['precision','min','max','segments','spacing']) if (src[key] != null && src[key] !== '') out[key] = Number(src[key]);
  if (type === 'stat-metric') { out.colorMode = ['value','background','fixed'].includes(src.colorMode) ? src.colorMode : 'value'; out.fixedColor = String(src.fixedColor ?? ''); out.sparkline = src.sparkline === 'none' ? 'none' : 'area'; }
  else { out.markers = !!src.markers; out.labels = !!src.labels; out.endpoint = src.endpoint === 'none' ? 'none' : 'point'; out.sparkline = src.sparkline === 'none' ? 'none' : 'area'; }
  out.thresholds = Array.isArray(src.thresholds) ? copy(src.thresholds) : [];
  const fb = src.fallback || {};
  out.fallback = { enabled: !!fb.enabled, value: fb.enabled ? (fb.value ?? null) : null, label: String(fb.label ?? '') };
  return out;
}
export function applyPhase2FormValues(type, existing = {}, values = {}) {
  if (type === 'static-text') return { ...copy(existing || {}), content: String(values.content ?? '') };
  let thresholds;
  try { thresholds = typeof values.thresholds === 'string' ? JSON.parse(values.thresholds || '[]') : copy(values.thresholds ?? []); }
  catch { throw new Error('Thresholds must be valid JSON'); }
  if (!Array.isArray(thresholds)) throw new Error('Thresholds must be a JSON array');
  const get = (name, old) => values[name] !== undefined ? values[name] : old;
  const bind = values['binding.metric'] ?? values.metric ?? existing.binding?.metric ?? existing.metric ?? '';
  const val = { ...normalizePhase2FamilyConfig(type, existing), ...values, binding:{ metric:String(bind) }, thresholds };
  val.reducer = 'lastNotNull';
  if (type === 'stat-metric') {
    val.colorMode = ['value','background','fixed'].includes(values.colorMode) ? values.colorMode : normalizePhase2FamilyConfig(type, existing).colorMode;
    val.sparkline = ['area','none'].includes(values.sparkline) ? values.sparkline : normalizePhase2FamilyConfig(type, existing).sparkline;
  } else if (type === 'segmented-gauge') {
    val.endpoint = ['point','none'].includes(values.endpoint) ? values.endpoint : normalizePhase2FamilyConfig(type, existing).endpoint;
    val.sparkline = ['area','none'].includes(values.sparkline) ? values.sparkline : normalizePhase2FamilyConfig(type, existing).sparkline;
  }
  for (const k of ['precision','min','max','segments','spacing']) { const v=get(k, existing[k]); if (v === '' || v == null) delete val[k]; else { const n=Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be numeric`); val[k]=n; } }
  val.fallback = { enabled: !!get('fallback.enabled', existing.fallback?.enabled), value: null, label:String(get('fallback.label',existing.fallback?.label) ?? '') };
  const fv=get('fallback.value',existing.fallback?.value); val.fallback.value = val.fallback.enabled && fv !== '' && fv != null ? Number(fv) : null;
  if (val.fallback.value !== null && !Number.isFinite(val.fallback.value)) throw new Error('fallback.value must be numeric');
  if (type === 'segmented-gauge') { val.markers=!!get('markers',existing.markers); val.labels=!!get('labels',existing.labels); }
  return val;
}
