import { normalizeGaugeSeries } from './multiSeriesBarGauge.mjs';
import { clone, normalizeFields, gaugeGlobals, validateBounds, validateFormSeries, formSection } from './multiSeriesSchema.mjs';
export function normalizeBarGaugeSettings(config={}) {
  const c=clone(config);
  c.decimals ??= c.precision ?? 0;
  const result=normalizeFields(c,gaugeGlobals);
  validateBounds(result);
  result.series=normalizeGaugeSeries(c.series ?? [],{unit:result.unit,decimals:result.decimals,min:result.min,max:result.max});
  return result;
}
export function readBarGaugeForm(get, original={}) {
  const value=clone(original);
  for (const key of Object.keys(gaugeGlobals)) { const v=get(key); if (v !== undefined) value[key]=v; }
  if (get('series') !== undefined) value.series=formSection(get('series'),'Series',true);
  const result=normalizeBarGaugeSettings(value);
  validateFormSeries(result.series);
  return result;
}
