// Shared typed fields for runtime normalization and the structured editor.
export const clone = value => structuredClone(value);
const text = (label, extra = {}) => ({ label, type: 'text', ...extra });
const number = (label, extra = {}) => ({ label, type: 'number', ...extra });
const select = (label, options) => ({ label, type: 'select', options });
export const reducers = ['mean', 'last'];
export const calculations = ['mean', 'max', 'min', 'lastNotNull', 'last'];
export const seriesFields = {
  label: text('Label', {default:''}), 'binding.metric': text('Metric', {default:''}),
  unit: text('Unit', {default:''}), decimals: number('Decimals', {default:0, integer:true, min:0, max:100}),
};
export const timeseriesFields = {
  ...seriesFields, reducer: {...select('Reducer', reducers), default:'mean'},
  scale: number('Scale', {default:1}), color: text('Color (#RRGGBB)', {default:'#888888', hex:true}),
  axis: select('Axis assignment', ['y', 'y1']),
};
export const gaugeFields = {
  ...seriesFields, min:number('Minimum', {default:0}), max:number('Maximum'), color:text('Color'),
};
export const timeseriesGlobals = {
  title:text('Title'), lineWidth:number('Line width', {default:2, positive:true}),
  fillOpacity:number('Fill opacity', {default:.2, min:0, max:1}),
  windowMs:number('Fixed window (ms)', {default:60000, positive:true}), hours:number('Range hours', {default:24, positive:true}),
  stack:text('Stack (none, normal, or group name)'), smooth:{label:'Smooth', type:'checkbox', default:true},
  tension:number('Curve tension', {min:0, max:1}), range:text('Range button label'),
  reducer:select('Default reducer', reducers),
};
export const gaugeGlobals = {
  title:text('Title', {default:''}), unit:text('Unit', {default:''}),
  decimals:number('Decimals', {default:0, integer:true, min:0, max:100}),
  precision:number('Precision (legacy default)', {integer:true, min:0, max:100}),
  palette:{...select('Palette', ['power','energy']), default:'power'},
  min:number('Default minimum'), max:number('Default maximum'), legend:{label:'Show labels',type:'checkbox'},
};
export const axisFields = {
  type:select('Axis type', ['linear','logarithmic']), position:select('Axis position', ['auto','left','right']),
  min:number('Axis minimum'), max:number('Axis maximum'), centerZero:{label:'Center zero',type:'checkbox'},
};
export const thresholdFields = {
  value:number('Value'), color:text('Color'), label:text('Label'), dash:{label:'Line style (dash lengths, comma separated; empty = solid)',type:'dash'},
};
export function getField(value, key) { return key.split('.').reduce((v,k)=>v?.[k],value); }
export function setField(value, key, next) {
  const keys=key.split('.'); let target=value;
  for (const k of keys.slice(0,-1)) target=target[k] ??= {};
  target[keys.at(-1)]=next;
}
export function normalizeFields(source, fields) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Settings must be an object');
  const result=clone(source);
  for (const [key, field] of Object.entries(fields)) {
    let value=getField(source,key);
    if (value == null) value=field.default;
    if (value === undefined) continue;
    if (field.type === 'number') {
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim()==='' || !Number.isFinite(Number(value))) throw new Error(`${key} must be finite numeric input`);
      value=Number(value);
      if ((field.integer && !Number.isInteger(value)) || (field.min != null && value<field.min) || (field.max != null && value>field.max) || (field.positive && value<=0)) throw new Error(`${key} is out of range`);
    } else if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    } else if (field.type === 'select') {
      if (!field.options.includes(value)) throw new Error(`${key} must be ${field.options.join(', ')}`);
    } else if (field.type === 'dash') {
      if (!Array.isArray(value) || value.some(n=>typeof n !== 'number' || !Number.isFinite(n) || n<0)) throw new Error('Threshold dash must contain finite non-negative numbers');
    } else {
      if (typeof value !== 'string') throw new Error(`${key} must be text`);
      if (field.hex && value && !/^#[\da-f]{6}$/i.test(value)) throw new Error(`${key} must be #RRGGBB`);
    }
    setField(result,key,value);
  }
  return result;
}
export function validateBounds(value) {
  if (value.min != null && value.max != null && value.min>=value.max) throw new Error('max must exceed min');
}
export function normalizeSeriesFields(series, fields, defaults={}) {
  if (!Array.isArray(series)) throw new Error('series must be an array');
  return series.map(item=>{
    const source=clone(item);
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Series must be objects');
    if (source.binding != null && (typeof source.binding !== 'object' || Array.isArray(source.binding))) throw new Error('binding must be an object');
    source.binding={...source.binding,metric:source.binding?.metric ?? source.metric ?? ''};
    // Template null bounds and omitted unit/precision inherit block defaults.
    for (const [key,value] of Object.entries(defaults)) if (source[key] == null && value != null) source[key]=value;
    const result=normalizeFields(source,fields);
    if (fields.max) {
      if (result.max == null) throw new Error('max must exceed min');
      validateBounds(result);
    }
    return result;
  });
}
export function validateFormSeries(series) {
  for (const row of series) {
    // Unbound template placeholders are supported; a named row needs a metric.
    if (!row.binding.metric.trim() && (row.label.trim() || (row.color && row.color !== '#888888'))) throw new Error('A nonblank series row needs a metric');
  }
}
// Legacy callers can still supply serialized sections, while the editor supplies objects.
export function formSection(value, name, array=false) {
  if (typeof value === 'string') { try { value=JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON`); } }
  if (array ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON ${array?'array':'object'}`);
  return value;
}
