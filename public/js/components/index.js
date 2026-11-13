import { buildFlowCard } from './flowCard.js';
import { buildForecastBanner } from './forecastBanner.js';
import { buildMetricCards } from './metricCards.js';
import { buildGridCard, buildGeneratorCard } from './gridCard.js';
import { buildChartPower } from './chartPower.js';
import { buildChartEnergy } from './chartEnergy.js';
import { buildChartMetric } from './chartMetric.js';
import { buildTextMetricCard } from './textMetricCard.js';
import { applyTileIcon } from './tileIcon.js';
import { buildSavingsSummary } from './savingsSummary.js';
import { buildDataTableDaily } from './dataTableDaily.js';
import { buildDataTableMonthly } from './dataTableMonthly.js';
import { buildSystemTopology, updateSystemTopology } from './systemTopology.js';
import { buildMultiValueCard, updateMultiValueCard } from './multiValueCard.js';
import { buildGaugeCard, updateGaugeCard } from './gaugeCard.js';
import { buildConfigurableGaugeCard } from './configurableGaugeCard.js';
import { buildMetricTrendCard } from './metricTrendCard.js';
import { buildDualMetricCard } from './dualMetricCard.js';
import { buildTextCard } from './textCard.js';
import { buildIframeCard } from './iframeCard.js';
import { buildForecastSparkline } from './forecastSparkline.js';
import { buildForecastInfo } from './forecastInfo.js';
import { buildHalfGaugeCard, updateHalfGaugeCard } from './halfGaugeCard.js';
import { buildHalfGauge2Card, updateHalfGauge2Card } from './halfGauge2Card.js';
import { buildFlowCardSquare, updateFlowCardSquare } from './flowCardSquare.js';
import { buildPowerFlow } from './powerFlow.js';
import { buildRingGauge } from './ringGauge.js';
import { buildBatteryCard } from './batteryCard.js';
import { buildStatusList } from './statusList.js';
import { buildSystemHero } from './systemHero.js';
import { buildSpeedometer } from './speedometer.js';
import { buildFlowRows } from './flowRows.js';
import { buildMeterCard } from './meterCard.js';
import { buildPrepaidMeter } from './prepaidMeter.js';
import { buildFlowCardSquare2, updateFlowCardSquare2 } from './flowCardSquare2.js';
import { buildPvToday } from './pvToday.js';
import { buildEnergyDay } from './energyDay.js';
import { buildEnergyTotals } from './energyTotals.js';
import { buildEnergyFlows } from './energyFlows.js';
import { buildEnergyCosts } from './energyCosts.js';
import { buildSystemOverview } from './systemOverview.js';
import { buildEnergyTabs } from './energyTabs.js';
import { buildBarGauge } from './barGauge.js';
import { buildBarGaugeRetro } from './barGaugeRetro.js';
import { buildBarSingleCard } from './barSingleCard.js';
import { buildBarStackedCard } from './barStackedCard.js';
import { buildBarThresholdCard } from './barThresholdCard.js';
import { buildWeatherBlock } from './weatherBlock.js';
import { buildSwitchBlock } from './switchBlock.js';
import { buildButtonCard } from './buttonCard.js';
import { buildQuickActions } from './quickActions.js';
import { buildSliderCard } from './sliderCard.js';
import { buildRotaryCard } from './rotaryCard.js';
import { buildStateSelectBlock } from './stateSelectBlock.js';
import { buildControlPlaceholder } from './controlPlaceholder.js';
import { buildPeakBars, buildPeakHistogram } from './peakCharts.js';
import { registerBlock } from './blockRegistry.js';

export const componentBuilders = {
  'flow-card': buildFlowCard,
  'power-flow': buildPowerFlow,
  'ring-gauge': buildRingGauge,
  'battery-card': buildBatteryCard,
  'status-list': buildStatusList,
  'system-hero': buildSystemHero,
  'speedometer': buildSpeedometer,
  'flow-rows': buildFlowRows,
  'meter-card': buildMeterCard,
  'prepaid-meter': buildPrepaidMeter,
  'forecast-banner': buildForecastBanner,
  'forecast-sparkline': buildForecastSparkline,
  'forecast-info': buildForecastInfo,
  'metric-cards': buildMetricCards,
  'grid-card': buildGridCard,
  'generator-card': buildGeneratorCard,
  'chart-power': buildChartPower,
  'chart-energy': buildChartEnergy,
  'chart-metric': buildChartMetric,
  // The Text metric card has no imports of its own (see its header), so its optional icon is added here.
  'text-metric': block => { const card = buildTextMetricCard(block); applyTileIcon(card, (block && block.config || {}).icon); return card; },
  'savings-summary': buildSavingsSummary,
  'data-table-daily': buildDataTableDaily,
  'data-table-monthly': buildDataTableMonthly,
  'flow-card-2': buildSystemTopology,
  'multi-value': buildMultiValueCard,
  'gauge-card': buildGaugeCard,
  'configurable-gauge': buildConfigurableGaugeCard,
  'metric-trend': buildMetricTrendCard,
  'dual-metric': buildDualMetricCard,
  'half-gauge': buildHalfGaugeCard,
  'half-gauge-2': buildHalfGauge2Card,
  'flow-card-square': buildFlowCardSquare,
  'flow-card-square-2': buildFlowCardSquare2,
  'text-card': buildTextCard,
  'iframe-card': buildIframeCard,
  'forecast-pvtoday': buildPvToday,
  'energy-day': buildEnergyDay,
  'peak-bars': buildPeakBars,
  'peak-histogram': buildPeakHistogram,
  'energy-totals': buildEnergyTotals,
  'energy-flows': buildEnergyFlows,
  'energy-costs': buildEnergyCosts,
  'system-overview': buildSystemOverview,
  'energy-tabs': buildEnergyTabs,
  'bar-gauge': buildBarGauge,
  'bar-gauge-retro': buildBarGaugeRetro,
  'bar-single': buildBarSingleCard,
  'bar-stacked': buildBarStackedCard,
  'bar-threshold': buildBarThresholdCard,
  'weather-block': buildWeatherBlock,
  // Switches and selectors work only on the Controls page (password unlock,
  // change log); everywhere else they show a placeholder linking there.
  'switch-block': buildControlPlaceholder,
  'state-select': buildControlPlaceholder,
  'button-card': buildControlPlaceholder,
  'quick-actions': buildControlPlaceholder,
  'slider-card': buildControlPlaceholder,
  'rotary-card': buildControlPlaceholder
};

/** The working switch and selector cards, for the Controls page (and the showcase). */
export const controlBuilders = {
  'switch-block': buildSwitchBlock,
  'state-select': buildStateSelectBlock,
  'button-card': buildButtonCard,
  'quick-actions': buildQuickActions,
  'slider-card': buildSliderCard,
  'rotary-card': buildRotaryCard
};

// Every build registers its block so cards can look up their own config when
// they update (see blockRegistry.js), wherever they are rendered.
for (const builders of [componentBuilders, controlBuilders]) {
  for (const type of Object.keys(builders)) {
    const build = builders[type];
    builders[type] = (block = {}) => { registerBlock(block); return build(block); };
  }
}

/**
 * Builder for a block type, or null. Only the registry's own entries count —
 * a saved or imported layout naming an inherited property ("constructor",
 * "toString", …) must not resolve to a callable.
 */
export function getBuilder(type) {
  return Object.prototype.hasOwnProperty.call(componentBuilders, type) ? componentBuilders[type] : null;
}
