/** Pure helpers for the configurable gauge card. */
export const DEFAULT_CONFIG = Object.freeze({
  metric: '', title: '', unit: '', min: 0, max: 100, precision: 0,
  showReadout: true, readoutColor: '', readoutSize: 24,
  band: { show: false, thresholds: [], thickness: 8, spacing: 3, trackColor: '' },
  preset: 'continuous', segmentCount: 12, segmentColors: [], segmentGap: 2,
  style: 'flat', arcColor: '', gradientEnd: '', arcThickness: 12,
  trackColor: '', opening: 90, rotation: 0, size: 400,
  graph: { show: false, metric: '', window: '1h', mode: 'line', thickness: 2, color: '', opacity: .2, marker: false },
  background: '', borderColor: '', borderWidth: 0, radius: 12,
});
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function bounded(value, fallback, lo, hi) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, lo, hi) : fallback;
}
const text = value => typeof value === 'string' ? value : '';
// Accept only standalone colour tokens. The deliberately small deterministic
// grammar excludes declaration separators, functions other than numeric colour
// functions, URLs, custom properties, and quoted/escaped CSS syntax.
const COLOR_NAMES = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor').split(' '));
const colorSyntax = /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\(\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg|grad|rad|turn)?(?:\s*[, ]\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg|grad|rad|turn)?){2,3}\s*\))$/i;
function safeColor(value) {
  const color = text(value).trim();
  if (!color || !colorSyntax.test(color)) return '';
  const lower = color.toLowerCase();
  if (/^#[\da-f]+$/i.test(color)) return [4, 5, 7, 9].includes(color.length) ? color : '';
  if (/^(?:rgb|rgba|hsl|hsla)\(/i.test(color)) return color;
  return COLOR_NAMES.has(lower) ? color : '';
}

export function normalizeConfig(input = {}) {
  const c = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_CONFIG;
  const n = { ...d, ...c };
  n.min = Number.isFinite(Number(c.min)) ? Number(c.min) : d.min;
  n.max = Number.isFinite(Number(c.max)) ? Number(c.max) : d.max;
  n.validScale = n.min < n.max;
  n.metric = text(c.metric); n.title = text(c.title); n.unit = text(c.unit);
  n.precision = Math.round(bounded(c.precision, d.precision, 0, 6));
  n.showReadout = c.showReadout !== false;
  n.readoutColor = safeColor(c.readoutColor);
  n.readoutSize = bounded(c.readoutSize, d.readoutSize, 8, 48);
  n.band = { ...d.band, ...(c.band && typeof c.band === 'object' ? c.band : {}) };
  n.band.show = n.band.show === true;
  n.band.thickness = bounded(n.band.thickness, d.band.thickness, 1, 30);
  n.band.spacing = bounded(n.band.spacing, d.band.spacing, 0, 20);
  n.band.trackColor = safeColor(n.band.trackColor);
  n.band.thresholds = (Array.isArray(n.band.thresholds) ? n.band.thresholds : [])
    .map(t => ({ value: Number(t?.value), color: safeColor(t?.color) }))
    .filter(t => Number.isFinite(t.value) && t.color).sort((a, b) => a.value - b.value);
  n.preset = c.preset === 'segmented' ? 'segmented' : 'continuous';
  n.segmentCount = Math.round(bounded(c.segmentCount, d.segmentCount, 2, 48));
  n.segmentGap = bounded(c.segmentGap, d.segmentGap, 0, 12);
  n.segmentColors = Array.isArray(c.segmentColors) ? c.segmentColors.map(safeColor).filter(Boolean) : [];
  n.style = ['gradient', 'glow'].includes(c.style) ? c.style : 'flat';
  for (const key of ['arcColor', 'gradientEnd', 'trackColor', 'background', 'borderColor']) n[key] = safeColor(c[key]);
  n.arcThickness = bounded(c.arcThickness, d.arcThickness, 1, 36);
  n.opening = bounded(c.opening, d.opening, 30, 300);
  n.rotation = bounded(c.rotation, d.rotation, -360, 360);
  n.size = bounded(c.size, d.size, 80, 400);
  n.borderWidth = bounded(c.borderWidth, d.borderWidth, 0, 8);
  n.radius = bounded(c.radius, d.radius, 0, 32);
  n.graph = { ...d.graph, ...(c.graph && typeof c.graph === 'object' ? c.graph : {}) };
  n.graph.show = n.graph.show === true; n.graph.metric = text(n.graph.metric);
  n.graph.window = ['1h', '6h', '24h', '7d'].includes(n.graph.window) ? n.graph.window : '1h';
  n.graph.mode = n.graph.mode === 'area' ? 'area' : 'line';
  n.graph.thickness = bounded(n.graph.thickness, d.graph.thickness, 1, 8);
  n.graph.opacity = bounded(n.graph.opacity, d.graph.opacity, 0, 1);
  n.graph.color = safeColor(n.graph.color); n.graph.marker = n.graph.marker === true;
  return n;
}
export function finiteMetric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  return null;
}
export function scaleRatio(value, min, max) {
  const v = finiteMetric(value);
  return v === null || !Number.isFinite(min) || !Number.isFinite(max) || min >= max ? null : clamp((v - min) / (max - min), 0, 1);
}
export function thresholdBands(thresholds, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return [];
  const sorted = (Array.isArray(thresholds) ? thresholds : [])
    .map(t => ({ value: clamp(Number(t.value), min, max), color: t.color }))
    .filter(t => Number.isFinite(t.value)).sort((a, b) => a.value - b.value);
  return sorted.filter((item, i) => i === 0 || item.value !== sorted[i - 1].value);
}

/**
 * Infer a sampling cadence from typical adjacent deltas, then break at explicit
 * missing samples or deltas > 3x that cadence. At least two adjacent intervals are
 * required to infer cadence; a pair of samples alone is treated as ambiguous.
 */
export function historyRuns(points) {
  const samples = (Array.isArray(points) ? points : []).map(p => ({
    t: Number(p?.timestamp), v: finiteMetric(p?.value),
  })).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const deltas = samples.slice(1).map((p, i) => p.t - samples[i].t).filter(d => d > 0);
  const cadence = deltas.length >= 2 ? deltas.slice().sort((a, b) => a - b)[Math.floor((deltas.length - 1) / 2)] : null;
  // Without enough intervals to estimate cadence, sparse adjacency is ambiguous.
  if (cadence === null) return [];
  const valid = samples.filter(p => p.v !== null);
  if (valid.length < 2) return [];
  const minT = samples[0].t, maxT = samples[samples.length - 1].t;
  const values = valid.map(p => p.v), minV = Math.min(...values), maxV = Math.max(...values), span = maxV - minV || 1;
  const xy = p => `${((p.t - minT) / (maxT - minT || 1) * 100).toFixed(2)},${(30 - (p.v - minV) / span * 30).toFixed(2)}`;
  const runs = []; let run = [], previous = null;
  const flush = () => { if (run.length > 1) runs.push(run.map(xy)); run = []; previous = null; };
  for (const point of samples) {
    if (point.v === null || (previous && cadence !== null && point.t - previous.t > cadence * 3)) flush();
    if (point.v !== null) { run.push(point); previous = point; }
  }
  flush(); return runs;
}
export function historyPath(points, width = 100, height = 30) {
  return historyRuns(points).map(run => run.map((pair, i) => `${i ? 'L' : 'M'}${pair}`).join(' ')).join('');
}
export function historyAreaPath(points, width = 100, height = 30) {
  return historyRuns(points).map(run => `${run.map((pair, i) => `${i ? 'L' : 'M'}${pair}`).join(' ')} L${run[run.length - 1].split(',')[0]},${height} L${run[0].split(',')[0]},${height} Z`).join(' ');
}
export function rangeHours(window) { return ({ '1h': 1, '6h': 6, '24h': 24, '7d': 168 })[window] || 1; }
export function historyUrl(metric, window) { return `/api/metrics/history?metric=${encodeURIComponent(metric)}&hours=${rangeHours(window)}`; }
