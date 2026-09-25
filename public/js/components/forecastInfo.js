import { buildForecastShell } from './forecastShell.js';

// Solar forecast summary without the chart: today, next days, weather.
export function buildForecastInfo(block = {}) {
  return buildForecastShell(block, {
    kind: 'info', instanceClass: 'forecast-info-instance', summary: true, chart: false, defaultTitle: 'Solar Forecast'
  });
}
