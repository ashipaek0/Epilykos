import { formatMetric } from './format.js';

export const DEFAULT_METRIC_TREND = Object.freeze({
  preset: 'subtle-area', title: '', icon: '',
  value: { source: 'metric', metric: '', forecastValue: 'today-total', unit: '', forecastSource: 'default', restMap: {} },
  graph: { enabled: false, source: 'none', metric: '', window: '1h', forecastPeriod: 'today', forecastSource: 'default', restMap: {}, lineStyle: 'area', lineWidth: 2, marker: false, scale: 'auto', min: 0, max: 100 },
  // precision / font sizes null = automatic (decimals by magnitude, text scaled to the card).
  display: { precision: null, compact: false, valueFontSize: null, unitFontSize: null, align: 'center' },
  style: { headerColor: '', headerTextColor: '', bodyFill: '', bodyFillEnd: '', gradientAngle: 180, valueColor: '', unitColor: '', graphLineColor: '', graphFillColor: '', graphFillOpacity: .2, borderColor: '', borderWidth: 0, radius: 12, padding: 16 }
});
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bounded = (v, fallback, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : fallback; };
const text = v => typeof v === 'string' ? v : '';
const colorNames = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue crimson cyan darkblue darkcyan darkgray darkgreen darkgrey darkmagenta darkorange darkred darksalmon darkslateblue darkslategray darkslategrey darkturquoise deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro gold goldenrod gray green grey indigo ivory khaki lavender lightblue lightgray lightgreen lightpink lime magenta maroon mediumblue navy olive orange orchid pink plum purple rebeccapurple red salmon seagreen silver skyblue slateblue slategray tan teal tomato turquoise violet white yellow transparent currentcolor'.split(' '));
const colorRe = /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\(\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg|grad|rad|turn)?(?:\s*[, ]\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg|grad|rad|turn)?){2,3}\s*\))$/i;
export function safeTrendColor(v) { const s = text(v).trim(); if (!s || !colorRe.test(s)) return ''; if (s[0] === '#') return [4,5,7,9].includes(s.length) ? s : ''; if (/^(rgb|rgba|hsl|hsla)\(/i.test(s)) return s; return colorNames.has(s.toLowerCase()) ? s : ''; }
function mergeNested(base, value) { return { ...base, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) }; }
export function normalizeMetricTrendConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}, d = DEFAULT_METRIC_TREND;
  const c = { ...d, ...raw, value: mergeNested(d.value, raw.value), graph: mergeNested(d.graph, raw.graph), display: mergeNested(d.display, raw.display), style: mergeNested(d.style, raw.style) };
  c.preset = ['subtle-area', 'filled-body'].includes(c.preset) ? c.preset : d.preset;
  c.title = text(c.title); c.icon = text(c.icon);
  c.value.source = c.value.source === 'solar-forecast' ? 'solar-forecast' : 'metric'; c.value.metric = text(c.value.metric); c.value.unit = text(c.value.unit); c.value.forecastSource = text(c.value.forecastSource) || 'default'; c.value.restMap = mergeNested({}, c.value.restMap);
  c.value.forecastValue = ['today-total','today-remaining','tomorrow-total'].includes(c.value.forecastValue) ? c.value.forecastValue : 'today-total';
  c.graph.enabled = c.graph.enabled === true; c.graph.source = ['none','metric-history','solar-forecast'].includes(c.graph.source) ? c.graph.source : 'none'; c.graph.metric = text(c.graph.metric); c.graph.window = ['1h','6h','24h','7d'].includes(c.graph.window) ? c.graph.window : '1h'; c.graph.forecastPeriod = c.graph.forecastPeriod === 'tomorrow' ? 'tomorrow' : 'today'; c.graph.forecastSource = text(c.graph.forecastSource) || 'default'; c.graph.restMap = mergeNested({}, c.graph.restMap); c.graph.lineStyle = c.graph.lineStyle === 'line' ? 'line' : 'area'; c.graph.lineWidth = bounded(c.graph.lineWidth,2,.5,8); c.graph.marker = c.graph.marker === true; c.graph.scale = c.graph.scale === 'manual' ? 'manual' : 'auto'; c.graph.min = bounded(c.graph.min,0,-1e12,1e12); c.graph.max = bounded(c.graph.max,100,-1e12,1e12); c.graph.validScale = c.graph.scale !== 'manual' || c.graph.min < c.graph.max;
  const auto = v => v === null || v === undefined || v === ''; c.display.precision = auto(c.display.precision) ? null : Math.round(bounded(c.display.precision,1,0,6)); c.display.compact = c.display.compact === true; c.display.valueFontSize = auto(c.display.valueFontSize) ? null : bounded(c.display.valueFontSize,40,12,96); c.display.unitFontSize = auto(c.display.unitFontSize) ? null : bounded(c.display.unitFontSize,16,12,96); c.display.align = ['left','center','right'].includes(c.display.align) ? c.display.align : 'center';
  for (const k of Object.keys(d.style)) if (k.toLowerCase().includes('color') || k === 'bodyFill' || k === 'bodyFillEnd') c.style[k] = safeTrendColor(c.style[k]);
  c.style.gradientAngle = Math.round(bounded(c.style.gradientAngle,180,0,360)); c.style.graphFillOpacity = bounded(c.style.graphFillOpacity,.2,0,1); c.style.borderWidth = bounded(c.style.borderWidth,0,0,8); c.style.radius = bounded(c.style.radius,12,0,32); c.style.padding = bounded(c.style.padding,16,0,32);
  return c;
}
export function finiteMetric(value) { if (typeof value === 'number') return Number.isFinite(value) ? value : null; if (typeof value === 'string' && value.trim()) { const n = Number(value); return Number.isFinite(n) ? n : null; } return null; }
export function formatTrendValue(value, unit = '', precision = 1, compact = false) { const n = finiteMetric(value); if (n === null) return { value: '—', unit: '', empty: true }; const decimals = precision === null || precision === undefined ? undefined : Math.round(bounded(precision,1,0,6)); const formatted=formatMetric(n, text(unit), { decimals }); if(compact&&unit!=='W'&&unit!=='Wh'&&Math.abs(n)>=1000){formatted.value=new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:decimals ?? 1}).format(n);} return formatted; }
export function trendValueFromState(state, config) { if (config.value.source !== 'metric') return null; const e = state?.metrics?.[config.value.metric]; if (!e || e.quality === 'stale' || e.quality === 'unavailable') return null; return finiteMetric(e.value); }
export function historyTrendPath(points, width=100, height=50, fixedRange=null) {
  const valid = (Array.isArray(points)?points:[]).map(p=>({t:Number(p?.timestamp),v:finiteMetric(p?.value)})).filter(p=>Number.isFinite(p.t)).sort((a,b)=>a.t-b.t);
  if(valid.length<2)return '';
  const gaps=valid.slice(1).map((p,i)=>p.t-valid[i].t).filter(x=>x>0).sort((a,b)=>a-b), cadence=gaps.length>=2?gaps[Math.floor((gaps.length-1)/2)]:null;
  if(cadence===null)return '';
  const vals=valid.filter(p=>p.v!==null).map(p=>p.v); if(vals.length<2)return '';
  const rawLo=Math.min(...vals),rawHi=Math.max(...vals),lo=fixedRange?.min??(rawLo===rawHi?rawLo-.5:rawLo),hi=fixedRange?.max??(rawLo===rawHi?rawHi+.5:rawHi);
  if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>=hi)return '';
  const span=hi-lo,t0=valid[0].t,ts=valid[valid.length-1].t||t0; let runs=[],run=[],prev=null;
  const flush=()=>{if(run.length>1)runs.push(run);run=[];prev=null;};
  for(const p of valid){if(p.v===null||(prev&&p.t-prev.t>cadence*3))flush();if(p.v!==null){run.push(p);prev=p;}} flush();
  return runs.map(r=>r.map((p,i)=>`${i?'L':'M'}${clamp((p.t-t0)/(ts-t0||1)*width,0,width).toFixed(2)},${clamp(height-(p.v-lo)/span*height,0,height).toFixed(2)}`).join(' ')).join(' ');
}
export function historyTrendAreaPath(linePath, height=50) { return String(linePath||'').split(/(?=M)/).filter(Boolean).map(run=>{const coords=[...run.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(m=>[m[1],m[2]]); return coords.length>1?`${run} L${coords.at(-1)[0]},${height} L${coords[0][0]},${height} Z`:'';}).filter(Boolean).join(' '); }
export function metricHistoryRange(points) { const v=(Array.isArray(points)?points:[]).map(p=>finiteMetric(p?.value)).filter(n=>n!==null); return v.length?{min:Math.min(...v),max:Math.max(...v)}:null; }
export function historyUrl(metric, window) { return `/api/metrics/history?metric=${encodeURIComponent(metric)}&hours=${({ '1h':1,'6h':6,'24h':24,'7d':168 })[window]||1}`; }
function validDay(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false; const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s; }
export function serverForecastDate(data) { if (validDay(data?.server_today)) return data.server_today; const legacy = Array.isArray(data?.daily) ? data.daily.find(d => d && Object.prototype.hasOwnProperty.call(d, 'actual_so_far'))?.date : null; return validDay(legacy) ? legacy : null; }
function nextDay(day) { const d=new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10); }
export function forecastValue(data, choice, serverDate, now=Date.now()) { if (!data || !validDay(serverDate) || !Array.isArray(data.daily)) return null; if(choice==='today-total')return finiteMetric(data.daily.find(d=>d.date===serverDate)?.total_kwh); if(choice==='tomorrow-total')return finiteMetric(data.daily.find(d=>d.date===nextDay(serverDate))?.total_kwh); if(choice==='today-remaining'&&Array.isArray(data.hourly)){if(!data.hourly.every(h=>validDay(h?.date)&&finiteMetric(h?.energy_kwh)!==null&&Number.isFinite(Date.parse(h?.period_end))))return null;const future=data.hourly.filter(h=>{const t=Date.parse(h.period_end);return h.date===serverDate&&Number.isFinite(t)&&t>now;});return future.reduce((sum,h)=>sum+Number(h.energy_kwh),0);} return null; }
export function forecastGraphPoints(data, period, serverDate) { if(!data||!validDay(serverDate)||!Array.isArray(data.hourly))return [];const day=period==='tomorrow'?nextDay(serverDate):serverDate;return data.hourly.filter(h=>h?.date===day).map(h=>({timestamp:Date.parse(h.period_end),value:finiteMetric(h.energy_kwh),unit:'kWh'})).filter(p=>Number.isFinite(p.timestamp)); }
