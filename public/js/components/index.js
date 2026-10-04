import { buildFlowCard } from './flowCard.js';
import { buildForecastBanner } from './forecastBanner.js';
import { buildMetricCards } from './metricCards.js';
import { buildGridCard } from './gridCard.js';
import { buildChartPower } from './chartPower.js';
import { buildChartEnergy } from './chartEnergy.js';
import { buildChartMetric } from './chartMetric.js';
import { buildTextMetricCard } from './textMetricCard.js';
import { buildSavingsSummary } from './savingsSummary.js';
import { buildDataTableDaily } from './dataTableDaily.js';
import { buildDataTableMonthly } from './dataTableMonthly.js';
import { buildSystemTopology, updateSystemTopology } from './systemTopology.js';
import { buildMultiValueCard, updateMultiValueCard } from './multiValueCard.js';
import { buildGaugeCard, updateGaugeCard } from './gaugeCard.js';
import { buildConfigurableGaugeCard } from './configurableGaugeCard.js';
import { buildTextCard } from './textCard.js';
import { buildIframeCard } from './iframeCard.js';
import { buildForecastSparkline } from './forecastSparkline.js';
import { buildForecastInfo } from './forecastInfo.js';
import { buildHalfGaugeCard, updateHalfGaugeCard } from './halfGaugeCard.js';
import { buildHalfGauge2Card, updateHalfGauge2Card } from './halfGauge2Card.js';
import { buildFlowCardSquare, updateFlowCardSquare } from './flowCardSquare.js';
import { buildFlowCardSquare2, updateFlowCardSquare2 } from './flowCardSquare2.js';
import { buildPvToday } from './pvToday.js';
import { buildBarGauge } from './barGauge.js';
import { buildBarGaugeRetro } from './barGaugeRetro.js';
import { buildBarSingleCard } from './barSingleCard.js';
import { buildBarStackedCard } from './barStackedCard.js';
import { buildBarThresholdCard } from './barThresholdCard.js';
import { buildWeatherBlock } from './weatherBlock.js';
import { buildSwitchBlock } from './switchBlock.js';
import { buildStateSelectBlock } from './stateSelectBlock.js';
import { registerBlock } from './blockRegistry.js';

export const componentBuilders = {
  'flow-card': buildFlowCard,
  'forecast-banner': buildForecastBanner,
  'forecast-sparkline': buildForecastSparkline,
  'forecast-info': buildForecastInfo,
  'metric-cards': buildMetricCards,
  'grid-card': buildGridCard,
  'chart-power': buildChartPower,
  'chart-energy': buildChartEnergy,
  'chart-metric': buildChartMetric,
  'text-metric': buildTextMetricCard,
  'savings-summary': buildSavingsSummary,
  'data-table-daily': buildDataTableDaily,
  'data-table-monthly': buildDataTableMonthly,
  'flow-card-2': buildSystemTopology,
  'multi-value': buildMultiValueCard,
  'gauge-card': buildGaugeCard,
  'configurable-gauge': buildConfigurableGaugeCard,
  'half-gauge': buildHalfGaugeCard,
  'half-gauge-2': buildHalfGauge2Card,
  'flow-card-square': buildFlowCardSquare,
  'flow-card-square-2': buildFlowCardSquare2,
  'text-card': buildTextCard,
  'iframe-card': buildIframeCard,
  'forecast-pvtoday': buildPvToday,
  'bar-gauge': buildBarGauge,
  'bar-gauge-retro': buildBarGaugeRetro,
  'bar-single': buildBarSingleCard,
  'bar-stacked': buildBarStackedCard,
  'bar-threshold': buildBarThresholdCard,
  'weather-block': buildWeatherBlock,
  'switch-block': buildSwitchBlock,
  'state-select': buildStateSelectBlock
};

// Every build registers its block so cards can look up their own config when
// they update (see blockRegistry.js), wherever they are rendered.
for (const type of Object.keys(componentBuilders)) {
  const build = componentBuilders[type];
  componentBuilders[type] = (block = {}) => { registerBlock(block); return build(block); };
}

/**
 * Builder for a block type, or null. Only the registry's own entries count —
 * a saved or imported layout naming an inherited property ("constructor",
 * "toString", …) must not resolve to a callable.
 */
export function getBuilder(type) {
  return Object.prototype.hasOwnProperty.call(componentBuilders, type) ? componentBuilders[type] : null;
}
