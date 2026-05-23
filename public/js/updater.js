import { fetchDashboardState } from './api.js';
import { dashboardConfig } from './dashboard.js';
import { updateFlowCard } from './components/flowCard.js';
import { updateSystemTopology } from './components/systemTopology.js';
import { updateMultiValueCard } from './components/multiValueCard.js';
import { updateGaugeCard } from './components/gaugeCard.js';
import { updateHalfGaugeCard } from './components/halfGaugeCard.js';
import { updateHalfGauge2Card } from './components/halfGauge2Card.js';
import { updateFlowCardSquare } from './components/flowCardSquare.js';
import { updateFlowCardSquare2 } from './components/flowCardSquare2.js';
import { updatePvToday } from './components/pvToday.js';
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

  // Update screen-reader announcement with key metrics (throttled — aria-live="polite")
  const ariaEl = document.getElementById('aria-live-region');
  if (ariaEl && state.current && state.current.timestamp) {
    const c = state.current;
    const parts = [];
    if (c.solar_kw > 0) parts.push(`Solar ${Math.round(c.solar_kw * 1000)} watts`);
    if (c.consumption_kw > 0) parts.push(`Load ${Math.round(c.consumption_kw * 1000)} watts`);
    if (c.battery_soc != null) parts.push(`Battery ${Math.round(c.battery_soc)} percent`);
    if (state.gridStatus?.configured) parts.push(`Grid ${state.gridStatus.current ? 'on' : 'off'}`);
    ariaEl.textContent = parts.join('. ') || 'Dashboard updated';
  }
}
