import { uid } from '../utils/uid.js';

export function buildForecastBanner(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || {};
  const actualEnergyMetric = metrics.actual_energy || 'solar_kw';

  const banner = document.createElement('div');
  banner.className = 'pv-today-banner forecast-banner-instance';
  banner.id = uid('forecast-banner', id);
  banner.style.display = 'none';
  banner.dataset.metricMap = JSON.stringify({ actual_energy: actualEnergyMetric });
  banner.dataset.blockId = id;

  banner.innerHTML = `
    <div class="pv-top-bar">
      <h3>Solar Forecast</h3>
    </div>
    <div class="pv-main-row">
      <div class="pv-days">
        <div class="pv-day">
          <span class="pv-day-label">Today</span>
          <span class="pv-day-value" id="${uid('pv-today-value', id)}">0 kWh</span>
          <span class="pv-day-remaining" id="${uid('pv-today-remaining', id)}"></span>
        </div>
        <div class="pv-day">
          <span class="pv-day-label" id="${uid('pred-day1-label', id)}">Monday</span>
          <span class="pv-day-value" id="${uid('pv-tomorrow', id)}">0 kWh</span>
        </div>
        <div class="pv-day">
          <span class="pv-day-label" id="${uid('pred-day2-label', id)}">Tuesday</span>
          <span class="pv-day-value" id="${uid('pv-nextday', id)}">0 kWh</span>
        </div>
      </div>
      <div class="weather-section">
        <div class="weather-column" id="${uid('forecast-weather-current', id)}">
          <div class="forecast-date-clock">
            <span class="forecast-date" id="${uid('forecast-date', id)}"></span>
            <div class="forecast-clock" id="${uid('forecast-clock', id)}"></div>
          </div>
          <span class="weather-heading">Current Weather</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="${uid('weather-i', id)}"></i></div>
          <div class="weather-details"><span class="weather-temp" id="${uid('weather-temp', id)}">--°</span><span class="weather-desc" id="${uid('weather-desc', id)}">--</span><span class="weather-extra" id="${uid('weather-extra', id)}">--</span></div>
        </div>
        <div class="weather-column" id="${uid('forecast-weather-1', id)}" style="display:none;">
          <span class="weather-heading" id="${uid('fcast-heading-1', id)}">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="${uid('fcast-icon-1', id)}"></i></div>
          <div class="weather-details"><span class="weather-temp" id="${uid('fcast-temp-1', id)}">--°</span><span class="weather-desc" id="${uid('fcast-desc-1', id)}">--</span><span class="weather-extra" id="${uid('fcast-extra-1', id)}">--</span></div>
        </div>
        <div class="weather-column" id="${uid('forecast-weather-2', id)}" style="display:none;">
          <span class="weather-heading" id="${uid('fcast-heading-2', id)}">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="${uid('fcast-icon-2', id)}"></i></div>
          <div class="weather-details"><span class="weather-temp" id="${uid('fcast-temp-2', id)}">--°</span><span class="weather-desc" id="${uid('fcast-desc-2', id)}">--</span><span class="weather-extra" id="${uid('fcast-extra-2', id)}">--</span></div>
        </div>
      </div>
      <div class="pv-sparkline-container"><canvas id="${uid('pv-sparkline', id)}"></canvas></div>
    </div>
  `;
  return banner;
}

export function updateForecastStub() {
  import('../forecast.js').then(m => m.updateForecast());
}
