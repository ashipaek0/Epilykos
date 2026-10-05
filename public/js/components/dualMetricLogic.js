import { formatMetric } from './format.js';

export const DEFAULT_DUAL_METRIC_CONFIG = Object.freeze({
  preset: 'neutral', title: '', icon: '', helpText: '',
  panes: {
    // precision / font sizes null = automatic (decimals by magnitude, text scaled to the pane).
    left: { metric: '', label: '', unit: '', precision: null, valueColor: '', fillColor: '', labelColor: '', unitColor: '', valueFontSize: null, labelFontSize: null, unitFontSize: null, align: 'center' },
    right: { metric: '', label: '', unit: '', precision: null, valueColor: '', fillColor: '', labelColor: '', unitColor: '', valueFontSize: null, labelFontSize: null, unitFontSize: null, align: 'center' }
  },
  style: { borderColor: '', borderWidth: 0, radius: 12, padding: 16, paneGap: 0, dividerWidth: 2, dividerColor: '', headerColor: '', headerTextColor: '' }
});
const text = v => typeof v === 'string' ? v : '';
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const bounded = (v, fallback, min, max, integer = false) => {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim())) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, integer ? Math.round(n) : n)) : fallback;
};
const colorNames = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue crimson cyan darkblue darkcyan darkgray darkgreen darkgrey darkmagenta darkorange darkred darksalmon darkslateblue darkslategray darkslategrey darkturquoise deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro gold goldenrod gray green grey indigo ivory khaki lavender lightblue lightgray lightgreen lightpink lime magenta maroon mediumblue navy olive orange orchid pink plum purple rebeccapurple red salmon seagreen silver skyblue slateblue slategray tan teal tomato turquoise violet white yellow transparent'.split(' '));
export function safeDualMetricColor(value) {
  const s = text(value).trim();
  if (/^#[\da-f]{3}(?:[\da-f])?$|^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(s)) return s;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,()+-]+\)$/i.test(s)) return s;
  return colorNames.has(s.toLowerCase()) ? s : '';
}
function merge(base, value) { return { ...base, ...object(value) }; }
function normalizePane(value, base) {
  const p = merge(base, value);
  p.metric = text(p.metric); p.label = text(p.label); p.unit = text(p.unit);
  const auto = v => v === null || v === undefined || v === '';
  p.precision = auto(p.precision) ? null : bounded(p.precision, 1, 0, 6, true);
  for (const key of ['valueColor', 'fillColor', 'labelColor', 'unitColor']) p[key] = safeDualMetricColor(p[key]);
  p.valueFontSize = auto(p.valueFontSize) ? null : bounded(p.valueFontSize, 40, 12, 96);
  p.labelFontSize = auto(p.labelFontSize) ? null : bounded(p.labelFontSize, 14, 10, 32);
  p.unitFontSize = auto(p.unitFontSize) ? null : bounded(p.unitFontSize, 16, 10, 32);
  p.align = ['left', 'center', 'right'].includes(p.align) ? p.align : 'center';
  return p;
}
export function normalizeDualMetricConfig(input = {}) {
  const raw = object(input), d = DEFAULT_DUAL_METRIC_CONFIG;
  const c = { ...d, ...raw, panes: { ...d.panes, ...object(raw.panes) }, style: merge(d.style, raw.style) };
  c.preset = ['neutral', 'split-fill'].includes(c.preset) ? c.preset : d.preset;
  c.title = text(c.title); c.icon = text(c.icon); c.helpText = text(c.helpText);
  c.panes.left = normalizePane(object(raw.panes).left, d.panes.left);
  c.panes.right = normalizePane(object(raw.panes).right, d.panes.right);
  const s = c.style;
  for (const key of ['borderColor', 'dividerColor', 'headerColor', 'headerTextColor']) s[key] = safeDualMetricColor(s[key]);
  s.borderWidth = bounded(s.borderWidth, d.style.borderWidth, 0, 8);
  s.radius = bounded(s.radius, d.style.radius, 0, 32);
  s.padding = bounded(s.padding, d.style.padding, 0, 32);
  s.paneGap = bounded(s.paneGap, d.style.paneGap, 0, 16);
  s.dividerWidth = bounded(s.dividerWidth, d.style.dividerWidth, 0, 8);
  return c;
}
export function resolveDualMetricPane(state, pane = {}) {
  const entry = pane.metric ? state?.metrics?.[pane.metric] : null;
  if (entry?.quality === 'stale') return { status: 'Stale', formatted: null, entry };
  if (entry?.quality === 'unavailable') return { status: 'Unavailable', formatted: null, entry };
  if (!entry || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) return { status: 'Missing', formatted: null, entry };
  const unit = pane.unit || entry.unit || '';
  const decimals = pane.precision === null || pane.precision === undefined || pane.precision === '' ? undefined : bounded(pane.precision, 1, 0, 6, true);
  return { status: '', formatted: formatMetric(entry.value, unit, { decimals }), entry };
}
