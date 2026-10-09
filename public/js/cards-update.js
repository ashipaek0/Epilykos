/**
 * Push a dashboard state into every rendered card of the given types.
 *
 * Shared by the dashboard (updater.js) and the layout editor's live previews,
 * so it must not depend on either page's module state: cards find their own
 * elements and read their block config from components/blockRegistry.js.
 *
 * @module cards-update
 */
import { updateFlowCard } from './components/flowCard.js';
import { updateSystemTopology } from './components/systemTopology.js';
import { updateSystemOverview } from './components/systemOverview.js';
import { updateMultiValueCard } from './components/multiValueCard.js';
import { updateGaugeCard } from './components/gaugeCard.js';
import { updateConfigurableGaugeCards } from './components/configurableGaugeCard.js';
import { updateMetricTrendCards } from './components/metricTrendCard.js';
import { updateDualMetricCards } from './components/dualMetricCard.js';
import { updateHalfGaugeCard } from './components/halfGaugeCard.js';
import { updateHalfGauge2Card } from './components/halfGauge2Card.js';
import { updateBarGauge } from './components/barGauge.js';
import { updateBarGaugeRetro } from './components/barGaugeRetro.js';
import { refreshBarSingleCard } from './components/barSingleCard.js';
import { refreshBarStackedCard } from './components/barStackedCard.js';
import { refreshBarThresholdCard } from './components/barThresholdCard.js';
import { updateFlowCardSquare } from './components/flowCardSquare.js';
import { updateFlowCardSquare2 } from './components/flowCardSquare2.js';
import { updateMetricCardsFromState } from './components/metricCards.js';
import { updateGridCardFromState } from './components/gridCard.js';
import { updatePowerChartFromState, updateEnergyChartFromState, updateMetricChartFromState } from './charts.js';
import { updateSavingsFromState } from './components/savingsSummary.js';
import { updateForecast } from './forecast.js';
import { updateWeatherBlock } from './components/weatherBlock.js';
import { updateSwitchBlockFromState } from './components/switchBlock.js';
import { updateStateSelectBlockFromState } from './components/stateSelectBlock.js';
import { updateTextMetricCard } from './components/textMetricCard.js';
import { updateEnergyTotalsFromState } from './components/energyTotals.js';

const FORECAST_TYPES = ['forecast-banner', 'forecast-info', 'forecast-sparkline', 'forecast-pvtoday', 'pv-today', 'weather-block'];

/**
 * @param {object} state - dashboard state (GET /api/dashboard-state or a WebSocket push)
 * @param {Set<string>} blockTypes - types present, so unused updaters are skipped
 */
export function updateCards(state, blockTypes) {
  if (!state) return;
  if (blockTypes.has('flow-card')) updateFlowCard(state);
  if (blockTypes.has('flow-card-2')) updateSystemTopology(state);
  if (blockTypes.has('system-overview')) updateSystemOverview(state);
  if (blockTypes.has('multi-value')) updateMultiValueCard(state);
  if (blockTypes.has('gauge-card')) updateGaugeCard(state);
  if (blockTypes.has('configurable-gauge')) updateConfigurableGaugeCards(state);
  if (blockTypes.has('metric-trend')) updateMetricTrendCards(state);
  if (blockTypes.has('dual-metric')) updateDualMetricCards(state);
  if (blockTypes.has('half-gauge')) updateHalfGaugeCard(state);
  if (blockTypes.has('half-gauge-2')) updateHalfGauge2Card(state);
  if (blockTypes.has('bar-gauge')) updateBarGauge(state);
  if (blockTypes.has('bar-gauge-retro')) updateBarGaugeRetro(state);
  if (blockTypes.has('bar-single')) refreshBarSingleCard();
  if (blockTypes.has('bar-stacked')) refreshBarStackedCard();
  if (blockTypes.has('bar-threshold')) refreshBarThresholdCard();
  if (blockTypes.has('flow-card-square')) updateFlowCardSquare(state);
  if (blockTypes.has('flow-card-square-2')) updateFlowCardSquare2(state);
  if (blockTypes.has('metric-cards')) updateMetricCardsFromState(state);
  if (blockTypes.has('grid-card')) updateGridCardFromState(state);
  if (blockTypes.has('chart-power')) updatePowerChartFromState(state);
  if (blockTypes.has('chart-energy')) updateEnergyChartFromState(state);
  if (blockTypes.has('chart-metric')) updateMetricChartFromState(state);
  if (blockTypes.has('text-metric')) updateTextMetricCard(state);
  if (blockTypes.has('savings-summary')) updateSavingsFromState(state);
  // Day totals also appear as a tab inside Energy, tabbed.
  if (blockTypes.has('energy-totals') || blockTypes.has('energy-tabs')) updateEnergyTotalsFromState(state);
  if (FORECAST_TYPES.some(t => blockTypes.has(t))) updateForecast();
  if (blockTypes.has('weather-block')) updateWeatherBlock(state);
  if (blockTypes.has('switch-block')) updateSwitchBlockFromState(state);
  if (blockTypes.has('state-select')) updateStateSelectBlockFromState(state);
}
