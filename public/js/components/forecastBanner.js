import { buildForecastShell } from './forecastShell.js';

// Full solar forecast card: today's production, next days, weather, sparkline.
export function buildForecastBanner(block = {}) {
  return buildForecastShell(block, {
    kind: 'banner', instanceClass: 'forecast-banner-instance', summary: true, chart: true, defaultTitle: 'Solar Forecast'
  });
}
