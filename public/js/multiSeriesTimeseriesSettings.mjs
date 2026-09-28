import { normalizeSeries } from './multiSeriesTimeseries.mjs';
import { clone, normalizeFields, timeseriesGlobals, axisFields, thresholdFields, calculations, validateBounds, validateFormSeries, formSection } from './multiSeriesSchema.mjs';
export function normalizeMultiSeriesSettings(config={}) {
  const c=clone(config);
  const raw=c.stack;
  c.stack=raw === false || raw === 'false' || raw === '' || raw == null ? 'none' : raw;
  const out=normalizeFields(c,timeseriesGlobals);
  if (c.axis?.position != null && !axisFields.position.options.includes(c.axis.position)) throw new Error('Axis position must be auto, left or right');
  out.axis=normalizeFields(formSection(c.axis ?? {},'Axis'),axisFields);
  validateBounds(out.axis);
  out.legend=clone(formSection(c.legend ?? {},'Legend'));
  if (out.legend.position != null && !['bottom','right'].includes(out.legend.position)) throw new Error('Legend position must be bottom or right');
  if (out.legend.calculations != null && (!Array.isArray(out.legend.calculations) || out.legend.calculations.some(x=>!calculations.includes(x)))) throw new Error('Legend calculations must be supported calculations');
  out.thresholds=formSection(c.thresholds ?? [],'Thresholds',true).map(t=>{
    if (typeof t?.value !== 'number' || !Number.isFinite(t.value) || typeof t?.color !== 'string') throw new Error('Each threshold needs numeric value and color');
    return normalizeFields(t,thresholdFields);
  });
  out.series=normalizeSeries(c.series ?? [],{reducer:out.reducer});
  return out;
}
export function readMultiSeriesForm(get, original={}) {
  const value=clone(original);
  for (const key of Object.keys(timeseriesGlobals)) { const v=get(key); if (v !== undefined && !(v === '' && timeseriesGlobals[key].default === undefined && key !== 'stack')) value[key]=v; }
  for (const key of ['series','axis','legend','thresholds']) {
    const v=get(key); if (v !== undefined) value[key]=formSection(v,key[0].toUpperCase()+key.slice(1),key==='series'||key==='thresholds');
  }
  const result=normalizeMultiSeriesSettings(value);
  validateFormSeries(result.series);
  return result;
}
