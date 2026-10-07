/**
 * Block library for the dashboard editor: how each block type is named,
 * grouped and described, its default size, and the stroke icons the editor
 * uses. Block *rendering* stays in components/index.js; this file is only
 * the editor's presentation of that registry.
 */

const svg = (body, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const ICON_PATHS = {
  // UI
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  file: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
  spinner: '<path d="M12 3a9 9 0 109 9"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  // Blocks
  topology: '<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M7.5 11l9-5M7.5 13l9 5"/>',
  flow: '<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 4v16M4 12h16"/>',
  cards: '<rect x="3" y="6" width="8" height="12" rx="2"/><rect x="13" y="6" width="8" height="12" rx="2"/>',
  list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  text: '<path d="M5 6h14M12 6v12"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0V8zM12 16v5"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5a2.5 2 0 00-2.5-1.5c-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2a2.5 2 0 01-2.5-1.5M12 6.5v11"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1115 0"/><path d="M12 13l4-4"/>',
  metricTrend: '<path d="M3 18l5-6 4 3 8-9"/><path d="M3 21h18"/>',
  halfGauge: '<path d="M4 16a8 8 0 0116 0"/><path d="M12 16l4-5"/>',
  bars: '<path d="M4 7h12M4 12h16M4 17h8"/>',
  segments: '<path d="M4 8v8M8 8v8M12 8v8M16 8v8M20 8v8" stroke-dasharray="2 1"/>',
  barV: '<path d="M6 20V10M12 20V4M18 20v-7"/>',
  stack: '<path d="M6 20v-5M6 13V9M12 20v-8M12 10V5M18 20v-4M18 14v-3"/>',
  threshold: '<rect x="3" y="9" width="18" height="6" rx="2"/><path d="M14 6v12"/>',
  chartLine: '<path d="M3 17l5-6 4 3 6-8 3 4"/>',
  chartArea: '<path d="M3 20V14l5-5 4 3 6-7 3 3v12z"/>',
  diamond: '<path d="M12 3l8 9-8 9-8-9z"/>',
  table: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 10v9"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  sunLine: '<circle cx="7" cy="7" r="3"/><path d="M3 20l5-5 4 3 8-8"/>',
  sunInfo: '<circle cx="9" cy="9" r="4"/><path d="M14 17h7M14 21h5"/>',
  panel: '<path d="M4 15l2-9h12l2 9z"/><path d="M5.5 10h13M12 6v9M10 19h4M12 15v4"/>',
  cloud: '<path d="M17 18a5 5 0 00-1-9.9A7 7 0 004 10a4 4 0 001 8z"/>',
  toggle: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="3"/>',
  select: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 6v12M15 6v12"/>',
  embed: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'
};

export function icon(name, size) {
  return svg(ICON_PATHS[name] || ICON_PATHS.layers, size);
}

export const GROUPS = [
  { id: 'flow', label: 'Energy flow' },
  { id: 'values', label: 'Values' },
  { id: 'gauges', label: 'Gauges and bars' },
  { id: 'charts', label: 'Charts and tables' },
  { id: 'forecast', label: 'Forecast and weather' },
  { id: 'controls', label: 'Controls' },
  { id: 'content', label: 'Text and embeds' }
];

// w × h are GridStack columns (of 12) × rows (50 px each).
export const BLOCKS = {
  'flow-card-2':        { group: 'flow', name: 'System topology', desc: 'Animated flow between solar, battery, grid and home', icon: 'topology', w: 8, h: 7 },
  'flow-card':          { group: 'flow', name: 'Flow card', desc: 'Power flow with an optional solar gauge', icon: 'flow', w: 6, h: 6 },
  'flow-card-square':   { group: 'flow', name: 'Flow square', desc: 'Square flow layout with your inverter image', icon: 'square', w: 4, h: 6 },
  'flow-card-square-2': { group: 'flow', name: 'Flow square, alternate', desc: 'Square flow layout without the inverter image', icon: 'square', w: 4, h: 6 },

  'metric-cards':       { group: 'values', name: 'Metric cards', desc: 'A row of large single values', icon: 'cards', w: 12, h: 3 },
  'metric-trend':       { group: 'values', name: 'Metric trend', desc: 'A live metric with an optional history or forecast graph', icon: 'metricTrend', w: 4, h: 4 },
  'dual-metric':        { group: 'values', name: 'Dual metric', desc: 'Compare two live metric values side by side', icon: 'cards', w: 4, h: 3 },
  'multi-value':        { group: 'values', name: 'Multi-value list', desc: 'Label, value and unit rows', icon: 'list', w: 4, h: 4 },
  'text-metric':        { group: 'values', name: 'Text metric', desc: "One metric's current value as text", icon: 'text', w: 4, h: 2 },
  'grid-card':          { group: 'values', name: 'Grid status', desc: 'Grid on/off, hours and a 24-hour timeline', icon: 'plug', w: 4, h: 4 },
  'energy-totals':      { group: 'values', name: 'Day totals', desc: 'Energy to and from the grid, consumption and solar today, against forecast', icon: 'cards', w: 12, h: 3 },
  'savings-summary':    { group: 'values', name: 'Savings', desc: 'Savings today, this week, month and all time', icon: 'coin', w: 4, h: 4 },

  'gauge-card':         { group: 'gauges', name: 'Gauge', desc: 'One value on a round dial', icon: 'gauge', w: 3, h: 5 },
  'configurable-gauge': { group: 'gauges', name: 'Configurable gauge', desc: 'A fully configurable dial with bands and history', icon: 'gauge', w: 4, h: 5 },
  'half-gauge':         { group: 'gauges', name: 'Half gauge', desc: 'One value on a semicircle', icon: 'halfGauge', w: 3, h: 3 },
  'half-gauge-2':       { group: 'gauges', name: 'Half gauge, centre zero', desc: 'Zero at the top; fills right or left for negative values', icon: 'halfGauge', w: 3, h: 3 },
  'bar-gauge':          { group: 'gauges', name: 'Bar gauge', desc: 'Horizontal bars for several metrics', icon: 'bars', w: 4, h: 4 },
  'bar-gauge-retro':    { group: 'gauges', name: 'Bar gauge, segmented', desc: 'LED-style segmented bars for several metrics', icon: 'segments', w: 4, h: 4 },
  'bar-single':         { group: 'gauges', name: 'History bars', desc: "One metric's history as coloured vertical bars", icon: 'barV', w: 6, h: 4 },
  'bar-stacked':        { group: 'gauges', name: 'Stacked history bars', desc: 'Several metrics stacked per time bucket', icon: 'stack', w: 6, h: 4 },
  'bar-threshold':      { group: 'gauges', name: 'Threshold bar', desc: 'One value against coloured bands', icon: 'threshold', w: 4, h: 2 },

  'chart-power':        { group: 'charts', name: 'Power chart', desc: 'Solar, load, battery and grid power over time', icon: 'chartLine', w: 12, h: 6 },
  'chart-energy':       { group: 'charts', name: 'Energy chart', desc: 'Daily solar, grid and load energy as bars', icon: 'chartArea', w: 12, h: 6 },
  'energy-day':         { group: 'charts', name: 'Energy day', desc: 'Hourly consumption and solar with forecast, and battery charge', icon: 'chartArea', w: 12, h: 7 },
  'energy-flows':       { group: 'charts', name: 'Energy flows', desc: 'Where each hour\'s energy came from and went: solar, battery, grid, home', icon: 'stack', w: 12, h: 6 },
  'chart-metric':       { group: 'charts', name: 'Metric chart', desc: 'Any metrics over time, with units and scale', icon: 'diamond', w: 12, h: 6 },
  'data-table-daily':   { group: 'charts', name: 'Daily table', desc: 'Day-by-day energy totals', icon: 'table', w: 12, h: 6 },
  'data-table-monthly': { group: 'charts', name: 'Monthly table', desc: 'Month-by-month energy totals', icon: 'calendar', w: 12, h: 6 },

  'forecast-banner':    { group: 'forecast', name: 'Solar forecast', desc: "Today's production, next days, weather and a chart", icon: 'sun', w: 12, h: 4 },
  'forecast-info':      { group: 'forecast', name: 'Solar forecast summary', desc: 'Today and the next days, without the chart', icon: 'sunInfo', w: 6, h: 4 },
  'forecast-sparkline': { group: 'forecast', name: 'Solar forecast chart', desc: "Today's actual against forecast solar power", icon: 'sunLine', w: 6, h: 3 },
  'forecast-pvtoday':   { group: 'forecast', name: 'PV today', desc: 'Summary bar, weather timeline and chart', icon: 'panel', w: 6, h: 6 },
  'weather-block':      { group: 'forecast', name: 'Weather', desc: 'Conditions, forecast and alerts', icon: 'cloud', w: 6, h: 5 },

  'switch-block':       { group: 'controls', name: 'Toggle switch', desc: 'Turns a Home Assistant entity on or off', icon: 'toggle', w: 3, h: 2 },
  'state-select':       { group: 'controls', name: 'State select', desc: 'Pick one of several states for an entity', icon: 'select', w: 4, h: 2 },

  'text-card':          { group: 'content', name: 'Text', desc: 'A note or heading you write', icon: 'text', w: 6, h: 2 },
  'iframe-card':        { group: 'content', name: 'Embed', desc: 'Another web page in a frame', icon: 'embed', w: 6, h: 6 }
};

/** Library entry for a block type; unknown types get a neutral fallback. */
export function blockInfo(type) {
  return Object.prototype.hasOwnProperty.call(BLOCKS, type)
    ? BLOCKS[type]
    : { group: null, name: type, desc: '', icon: 'layers', w: 6, h: 4 };
}
