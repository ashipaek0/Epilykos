import { uid } from '../utils/uid.js';

// Standalone sparkline graph card
export function buildForecastSparkline(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || {};
  const actualField = metrics.actual_energy || 'solar_kw';

  const card = document.createElement('div');
  card.className = 'forecast-sparkline-card forecast-sparkline-instance';
  card.dataset.metricMap = JSON.stringify({ actual_energy: actualField });
  card.dataset.blockId = id;
  card.innerHTML = `<div class="pv-sparkline-container"><canvas id="${uid('fc-sparkline', id)}"></canvas></div>`;
  return card;
}

export function updateForecastSparkline(state) { /* handled by forecast.js */ }
