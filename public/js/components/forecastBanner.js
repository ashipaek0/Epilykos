export function buildForecastBanner(block = {}) {
  const config = block.config || {};
  const metrics = config.metrics || {};
  const actualEnergyMetric = metrics.actual_energy || 'solar_kw';

  const banner = document.createElement('div');
  banner.className = 'pv-today-banner';
  banner.id = 'forecast-banner';
  banner.style.display = 'none';
  banner.dataset.metricMap = JSON.stringify({ actual_energy: actualEnergyMetric });

  banner.innerHTML = `
    <div class="pv-top-bar">
      <div>
        <h3>Solar Forecast</h3>
        <div class="forecast-clock" id="forecast-clock"></div>
      </div>
      <span class="forecast-date" id="forecast-date"></span>
    </div>
    <div class="pv-main-row">
      <div class="pv-days">
        <div class="pv-day">
          <span class="pv-day-label">Today</span>
          <span class="pv-day-value" id="pv-today-value">0 kWh</span>
          <span class="pv-day-remaining" id="pv-today-remaining"></span>
        </div>
        <div class="pv-day">
          <span class="pv-day-label" id="pred-day1-label">Monday</span>
          <span class="pv-day-value" id="pv-tomorrow">0 kWh</span>
        </div>
        <div class="pv-day">
          <span class="pv-day-label" id="pred-day2-label">Tuesday</span>
          <span class="pv-day-value" id="pv-nextday">0 kWh</span>
        </div>
      </div>
      <div class="weather-section">
        <div class="weather-column" id="forecast-weather-current">
          <span class="weather-heading">Current Weather</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="weather-i"></i></div>
          <div class="weather-details"><span class="weather-temp" id="weather-temp">--°</span><span class="weather-desc" id="weather-desc">--</span><span class="weather-extra" id="weather-extra">--</span></div>
        </div>
        <div class="weather-column" id="forecast-weather-1" style="display:none;">
          <span class="weather-heading" id="fcast-heading-1">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="fcast-icon-1"></i></div>
          <div class="weather-details"><span class="weather-temp" id="fcast-temp-1">--°</span><span class="weather-desc" id="fcast-desc-1">--</span><span class="weather-extra" id="fcast-extra-1">--</span></div>
        </div>
        <div class="weather-column" id="forecast-weather-2" style="display:none;">
          <span class="weather-heading" id="fcast-heading-2">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="fcast-icon-2"></i></div>
          <div class="weather-details"><span class="weather-temp" id="fcast-temp-2">--°</span><span class="weather-desc" id="fcast-desc-2">--</span><span class="weather-extra" id="fcast-extra-2">--</span></div>
        </div>
      </div>
      <div class="pv-sparkline-container"><canvas id="pv-sparkline" width="300" height="160"></canvas></div>
    </div>
  `;
  return banner;
}

export function updateForecastStub() {
  import('../forecast.js').then(m => m.updateForecast());
}
