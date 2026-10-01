import { fetchDashboardState } from './api.js';
import { dashboardConfig } from './dashboard.js';
import { updateCards } from './cards-update.js';

let fetchFailureLogged = false;

export async function updateAllComponents() {
  try {
    const state = await fetchDashboardState();
    updateWithState(state);
    fetchFailureLogged = false;
  } catch (e) {
    if (!fetchFailureLogged) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[Dashboard] State update failed: ${message}`);
      fetchFailureLogged = true;
    }
  }
}

export function updateWithState(state) {
  if (!dashboardConfig?.dashboards) return;
  const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
  if (!activeLayout) return;
  updateCards(state, new Set(activeLayout.map(b => b.type)));

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
