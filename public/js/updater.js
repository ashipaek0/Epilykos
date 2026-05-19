import { fetchDashboardState } from './api.js';
import { dashboardConfig } from './dashboard.js';
import { updateFlowCard } from './components/flowCard.js';
import { updateBatteryBlock } from './components/batteryBlock.js';
import { updateSystemTopology } from './components/systemTopology.js';
import { updateMultiValueCard } from './components/multiValueCard.js';
import { updateGaugeCard } from './components/gaugeCard.js';
import { updateHalfGaugeCard } from './components/halfGaugeCard.js';
import { updateHalfGauge2Card } from './components/halfGauge2Card.js';
import { updateFlowCardSquare } from './components/flowCardSquare.js';
import { updateFlowCardSquare2 } from './components/flowCardSquare2.js';
import { updateMetricCardsFromState } from './components/metricCards.js';
import { updateGridCardFromState } from './components/gridCard.js';
import { updatePowerChartFromState, updateEnergyChartFromState } from './charts.js';
import { updateSavingsFromState } from './components/savingsSummary.js';
import { updateForecast } from './forecast.js';

export async function updateAllComponents() {
  try { const state = await fetchDashboardState(); updateWithState(state); } catch (e) { console.error(e); }
}

export function updateWithState(state) {
  const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
  if (!activeLayout) return;
  if (activeLayout.some(b => b.type === 'flow-card')) updateFlowCard(state);
  if (activeLayout.some(b => b.type === 'battery-block')) updateBatteryBlock(state);
  if (activeLayout.some(b => b.type === 'flow-card-2')) updateSystemTopology(state);
  if (activeLayout.some(b => b.type === 'multi-value')) updateMultiValueCard(state);
  if (activeLayout.some(b => b.type === 'gauge-card')) updateGaugeCard(state);
  if (activeLayout.some(b => b.type === 'half-gauge')) updateHalfGaugeCard(state);
  if (activeLayout.some(b => b.type === 'half-gauge-2')) updateHalfGauge2Card(state);
  if (activeLayout.some(b => b.type === 'flow-card-square')) updateFlowCardSquare(state);
  if (activeLayout.some(b => b.type === 'flow-card-square-2')) updateFlowCardSquare2(state);
  if (activeLayout.some(b => b.type === 'metric-cards')) updateMetricCardsFromState(state);
  if (activeLayout.some(b => b.type === 'grid-card')) updateGridCardFromState(state);
  if (activeLayout.some(b => b.type === 'chart-power')) updatePowerChartFromState(state);
  if (activeLayout.some(b => b.type === 'chart-energy')) updateEnergyChartFromState(state);
  if (activeLayout.some(b => b.type === 'savings-summary')) updateSavingsFromState(state);
  updateForecast();
}
