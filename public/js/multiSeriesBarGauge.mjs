import { normalizeSeriesFields, gaugeFields } from './multiSeriesSchema.mjs';
export function normalizeGaugeSeries(series=[], defaults={}) { return normalizeSeriesFields(series, gaugeFields, defaults); }
export function gaugeValue(series, values={}) { const metric=series?.binding?.metric; if(!metric||!values||!Object.prototype.hasOwnProperty.call(values,metric)||values[metric]===null||values[metric]===undefined||!Number.isFinite(Number(values[metric]))) return {status:'no-data',value:null}; return {status:'data',value:Number(values[metric])}; }
export function gaugeFillPercent(value,min,max) { if(!Number.isFinite(Number(value))||!Number.isFinite(Number(min))||!Number.isFinite(Number(max))||Number(max)<=Number(min)) return 0; return Math.max(0,Math.min(100,(Number(value)-Number(min))/(Number(max)-Number(min))*100)); }
/**
 * Flat threshold-band color standing in for Grafana's continuous gradient
 * (source panel-15 uses "continuous-GrYlRd" for power, panel-42 uses
 * "continuous-BlYlRd" for energy — house style forbids real CSS gradients,
 * so we approximate with 3 flat bands low/mid/high). Colors come from
 * CSS custom properties (warm residential palette), never hardcoded hex,
 * so both themes and future palette edits apply automatically.
 * @param {number} value
 * @param {number} max
 * @param {'power'|'energy'} [palette='power']
 * @param {(name:string)=>string} [readVar] CSS var resolver, injected for testability
 */
export function gaugeColor(value,max,palette='power',readVar) {
  const ratio=Number(value)/Number(max);
  if(!Number.isFinite(ratio)) return '';
  const resolve = readVar || (typeof document!=='undefined'
    ? (name)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    : ()=>'');
  const bands = palette==='energy'
    ? [resolve('--sky-500'), resolve('--color-warning'), resolve('--color-danger')]
    : [resolve('--olive-500'), resolve('--color-warning'), resolve('--color-danger')];
  const idx = ratio<0.5 ? 0 : ratio<0.8 ? 1 : 2;
  return bands[idx] || '';
}
