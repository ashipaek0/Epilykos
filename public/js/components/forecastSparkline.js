import { buildForecastShell } from './forecastShell.js';

// Chart-only card: today's actual vs forecast solar power.
export function buildForecastSparkline(block = {}) {
  return buildForecastShell(block, {
    kind: 'spark', instanceClass: 'forecast-sparkline-instance', summary: false, chart: true, defaultTitle: 'Solar Today'
  });
}
