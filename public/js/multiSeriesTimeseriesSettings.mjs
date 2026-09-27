import { normalizeSeries } from './multiSeriesTimeseries.mjs';

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
  return value;
}
function parse(value, name, kind) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON`); }
  if (kind === 'array' && !Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  if (kind === 'object') object(parsed, name);
  return parsed;
}
export function normalizeMultiSeriesSettings(config) {
  const c = config || {};
  const axis = object(c.axis ?? {}, 'Axis');
  const legend = object(c.legend ?? {}, 'Legend');
  const thresholds = c.thresholds ?? [];
  if (!Array.isArray(thresholds) || thresholds.some(t => !t || typeof t !== 'object' || Array.isArray(t))) throw new Error('Thresholds must be an array of objects');
  if (legend.calculations != null && (!Array.isArray(legend.calculations) || legend.calculations.some(x => !['mean','max','min','lastNotNull'].includes(x)))) throw new Error('Legend calculations must be supported calculations');
  if (axis.position != null && !['left','right'].includes(axis.position)) throw new Error('Axis position must be left or right');
  for (const t of thresholds) if (typeof t.value !== 'number' || typeof t.color !== 'string' || (t.dash != null && !Array.isArray(t.dash))) throw new Error('Each threshold needs numeric value, color and optional dash array');
  const rawStack = c.stack ?? 'none';
  const stack = rawStack === false || rawStack === 'false' || rawStack === '' || rawStack === 'none' ? 'none' : rawStack;
  if (stack !== 'normal' && typeof stack !== 'string') throw new Error('Stack must be none, normal or a group name');
  const numbers = ['lineWidth','fillOpacity','windowMs','hours'];
  const out = {...c, series: normalizeSeries(c.series ?? []), axis, legend, thresholds, stack, smooth: c.smooth !== false};
  for (const key of numbers) out[key] = Number(c[key] ?? ({lineWidth:2,fillOpacity:.2,windowMs:60000,hours:24}[key]));
  if (!(out.lineWidth > 0) || !(out.windowMs > 0) || !(out.hours > 0) || out.fillOpacity < 0 || out.fillOpacity > 1) throw new Error('Line width, window, range and opacity are out of range');
  return out;
}
export function readMultiSeriesForm(get) {
  return normalizeMultiSeriesSettings({title:get('title'),series:parse(get('series'),'Series','array'),lineWidth:get('lineWidth'),fillOpacity:get('fillOpacity'),windowMs:get('windowMs'),hours:get('hours'),smooth:get('smooth'),stack:get('stack') || 'none',axis:parse(get('axis'),'Axis','object'),legend:parse(get('legend'),'Legend','object'),thresholds:parse(get('thresholds'),'Thresholds','array')});
}
