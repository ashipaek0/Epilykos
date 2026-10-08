/**
 * Showcase cards: one of every dashboard card type, set up with options that
 * show it at its best. The metric names here are the showcase's own made-up
 * metrics (showcase-data.js serves them); nothing reads or writes real data.
 *
 * @module showcase-layout
 */
const FLOW = {
  solar: 'solar', battery_soc: 'battery_soc', battery_charge: 'battery_charge', battery_discharge: 'battery_discharge',
  consumption: 'consumption', grid_import: 'grid_import', grid_export: 'grid_export'
};

/** type → block config (and extra block fields, e.g. a taller gridH). Order follows the editor's library. */
export const SHOWCASE_BLOCKS = [
  { type: 'flow-card-2', config: { metrics: FLOW } },
  { type: 'system-overview', config: { title: 'System overview' } },
  { type: 'flow-card', config: { metrics: FLOW } },
  { type: 'flow-card-square', config: { metrics: FLOW } },
  { type: 'flow-card-square-2', config: { metrics: FLOW } },

  { type: 'metric-cards', config: {}, cards: [
    { title: 'Solar', metric: 'solar', unit: 'W' }, { title: 'Load', metric: 'consumption', unit: 'W' },
    { title: 'Battery', metric: 'battery_soc', unit: '%' }, { title: 'Grid', metric: 'grid_import', unit: 'W' }] },
  { type: 'metric-trend', config: { title: 'Solar power', value: { source: 'metric', metric: 'solar', unit: 'W' },
    graph: { enabled: true, source: 'metric-history', metric: 'solar', window: '24h', lineStyle: 'area' } } },
  { type: 'dual-metric', config: { title: 'Battery', panes: {
    left: { metric: 'battery_soc', label: 'Charge', unit: '%' }, right: { metric: 'battery_voltage', label: 'Voltage', unit: 'V' } } } },
  { type: 'multi-value', config: { metrics: [
    { label: 'Inverter temperature', metric: 'inverter_temperature', unit: '°C' }, { label: 'Grid voltage', metric: 'grid_voltage', unit: 'V' },
    { label: 'PV voltage', metric: 'pv_voltage', unit: 'V' }, { label: 'Mode', metric: 'inverter_mode', unit: '' }] } },
  { type: 'text-metric', config: { metric: 'inverter_mode', label: 'Inverter mode', unit: '' } },
  { type: 'grid-card', config: {} },
  { type: 'energy-totals', config: {} },
  { type: 'savings-summary', config: { title: 'Savings' } },

  { type: 'gauge-card', config: { metric: 'battery_soc', title: 'Battery', min: 0, max: 100 } },
  { type: 'configurable-gauge', config: { metric: 'inverter_temperature', title: 'Inverter temperature', unit: '°C', min: 0, max: 80,
    band: { show: true, thresholds: [{ value: 0, color: '#22c55e' }, { value: 50, color: '#f59e0b' }, { value: 65, color: '#ef4444' }] } } },
  { type: 'half-gauge', config: { metric: 'solar', title: 'Solar', min: 0, max: 5000 } },
  { type: 'half-gauge-2', config: { metric: 'battery_power', title: 'Battery power', min: -3000, max: 3000 } },
  { type: 'bar-gauge', config: { metrics: [
    { label: 'Battery', metric: 'battery_soc', unit: '%', min: 0, max: 100 }, { label: 'Solar', metric: 'solar', unit: 'W', min: 0, max: 5000 },
    { label: 'Load', metric: 'consumption', unit: 'W', min: 0, max: 3000 }] } },
  { type: 'bar-gauge-retro', config: { metrics: [
    { label: 'Battery', metric: 'battery_soc', unit: '%', min: 0, max: 100, segments: 12 },
    { label: 'Load', metric: 'load_percent', unit: '%', min: 0, max: 100, segments: 12 }] } },
  { type: 'bar-single', config: { metric: 'solar', title: 'Solar, last 24 hours', range: '24h', bucket: '1h' } },
  { type: 'bar-stacked', config: { title: 'Solar and grid', range: '24h', bucket: '1h', metrics: [
    { label: 'Solar', metric: 'solar', color: '#f59e0b' }, { label: 'Grid', metric: 'grid_import', color: '#87aec8' }] } },
  { type: 'bar-threshold', config: { metric: 'battery_soc', title: 'Battery' } },

  { type: 'chart-power', config: { title: 'Power today' } },
  { type: 'chart-energy', config: {} },
  { type: 'energy-day', config: { showForecast: true, showBattery: true } },
  { type: 'energy-flows', config: {} },
  { type: 'energy-costs', config: {} },
  { type: 'energy-tabs', config: {} },
  { type: 'chart-metric', config: { datasets: [
    { label: 'Inverter temperature', metric: 'inverter_temperature', color: '#b45309', unit: '°C' }] } },
  { type: 'data-table-daily', config: {} },
  { type: 'data-table-monthly', config: {} },

  { type: 'forecast-banner', config: {}, gridH: 5 },
  { type: 'forecast-info', config: {} },
  { type: 'forecast-sparkline', config: {} },
  { type: 'forecast-pvtoday', config: {} },
  { type: 'weather-block', config: { title: 'Weather' }, gridH: 9 },

  { type: 'switch-block', config: { entity: 'switch.generator', source: 'showcase', label: 'Generator' } },
  { type: 'state-select', config: { entity: 'select.inverter_mode', source: 'showcase', label: 'Inverter mode',
    states: [{ value: 'Solar first', label: 'Solar first' }, { value: 'Battery first', label: 'Battery first' }, { value: 'Grid first', label: 'Grid first' }] } },

  { type: 'text-card', config: { content: 'Roof array: 12 × 400 W panels, facing south.' } },
  { type: 'iframe-card', config: { url: 'about:blank', title: 'Embedded page' } }
];
