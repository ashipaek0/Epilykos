import { buildFlowCard } from './flowCard.js';
import { buildForecastBanner } from './forecastBanner.js';
import { buildMetricCards } from './metricCards.js';
import { buildGridCard } from './gridCard.js';
import { buildChartPower } from './chartPower.js';
import { buildChartEnergy } from './chartEnergy.js';
import { buildSavingsSummary } from './savingsSummary.js';
import { buildDataTableDaily } from './dataTableDaily.js';
import { buildDataTableMonthly } from './dataTableMonthly.js';
import { buildWeatherBlock } from './weatherBlock.js';
import { buildBatteryBlock } from './batteryBlock.js';

export const componentBuilders = {
  'flow-card': buildFlowCard,
  'forecast-banner': buildForecastBanner,
  'metric-cards': buildMetricCards,
  'grid-card': buildGridCard,
  'chart-power': buildChartPower,
  'chart-energy': buildChartEnergy,
  'savings-summary': buildSavingsSummary,
  'data-table-daily': buildDataTableDaily,
  'data-table-monthly': buildDataTableMonthly,
  'weather-block': buildWeatherBlock,
  'battery-block': buildBatteryBlock
};
