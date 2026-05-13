import { fetchDashboardState } from './api.js';
import { dashboardConfig } from './dashboard.js';
import { updateFlowCard } from './components/flowCard.js';
import { updateMetricCardsFromState } from './components/metricCards.js';
import { updateGridCardFromState } from './components/gridCard.js';
import { updatePowerChartFromState, updateEnergyChartFromState } from './charts.js';
import { updateSavingsFromState } from './components/savingsSummary.js';
import { updateForecast } from './forecast.js';

// Main update function that fetches state
export async function updateAllComponents() {
  try {
    const state = await fetchDashboardState();
    updateWithState(state);
  } catch (e) {
    console.error(e);
  }
}

// Update function that uses a provided state (e.g., from WebSocket)
export function updateWithState(state) {
  const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
  if (!activeLayout) return;
  if (activeLayout.some(b => b.type === 'flow-card')) updateFlowCard(state);
  if (activeLayout.some(b => b.type === 'metric-cards')) updateMetricCardsFromState(state);
  if (activeLayout.some(b => b.type === 'grid-card')) updateGridCardFromState(state);
  if (activeLayout.some(b => b.type === 'chart-power')) updatePowerChartFromState(state);
  if (activeLayout.some(b => b.type === 'chart-energy')) updateEnergyChartFromState(state);
  if (activeLayout.some(b => b.type === 'savings-summary')) updateSavingsFromState(state);
  updateForecast(); // forecast has its own refresh mechanism
}
