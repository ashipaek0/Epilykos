import { uid } from '../utils/uid.js';

// Weather + days info card (split from forecast banner)
export function buildForecastInfo(block = {}) {
  const id = block.id || '';
  const config = block.config || {};

  const card = document.createElement('div');
  card.className = 'forecast-info-card forecast-info-instance';
  card.dataset.blockId = id;
  card.style.display = 'none';

  card.innerHTML = `
    <div class="pv-top-bar">
      <h3>Solar Forecast</h3>
    </div>
    <div class="pv-main-row">
      <div class="pv-days">
        <div class="pv-day"><span class="pv-day-label">Today</span><span class="pv-day-value" id="${uid('fi-today-value', id)}">0 kWh</span><span class="pv-day-remaining" id="${uid('fi-today-remaining', id)}"></span></div>
        <div class="pv-day"><span class="pv-day-label" id="${uid('fi-day1-label', id)}">Monday</span><span class="pv-day-value" id="${uid('fi-tomorrow', id)}">0 kWh</span></div>
        <div class="pv-day"><span class="pv-day-label" id="${uid('fi-day2-label', id)}">Tuesday</span><span class="pv-day-value" id="${uid('fi-nextday', id)}">0 kWh</span></div>
      </div>
      <div class="weather-section">
        <div class="weather-column" id="${uid('fi-weather-current', id)}">
          <div class="forecast-date-clock" style="margin-bottom:0.5rem;">
            <span class="forecast-date" id="${uid('fi-date', id)}"></span>
            <div class="forecast-clock" id="${uid('fi-clock', id)}"></div>
          </div>
          <span class="weather-heading">Current Weather</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="${uid('fi-weather-i', id)}"></i></div>
          <div class="weather-details"><span class="weather-temp" id="${uid('fi-weather-temp', id)}">--°</span><span class="weather-desc" id="${uid('fi-weather-desc', id)}">--</span><span class="weather-extra" id="${uid('fi-weather-extra', id)}">--</span></div>
        </div>
        <div class="weather-column" id="${uid('fi-weather-1', id)}" style="display:none;">
          <span class="weather-heading" id="${uid('fi-fcast-heading-1', id)}">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="${uid('fi-fcast-icon-1', id)}"></i></div>
          <div class="weather-details"><span class="weather-temp" id="${uid('fi-fcast-temp-1', id)}">--°</span><span class="weather-desc" id="${uid('fi-fcast-desc-1', id)}">--</span><span class="weather-extra" id="${uid('fi-fcast-extra-1', id)}">--</span></div>
        </div>
        <div class="weather-column" id="${uid('fi-weather-2', id)}" style="display:none;">
          <span class="weather-heading" id="${uid('fi-fcast-heading-2', id)}">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="${uid('fi-fcast-icon-2', id)}"></i></div>
          <div class="weather-details"><span class="weather-temp" id="${uid('fi-fcast-temp-2', id)}">--°</span><span class="weather-desc" id="${uid('fi-fcast-desc-2', id)}">--</span><span class="weather-extra" id="${uid('fi-fcast-extra-2', id)}">--</span></div>
        </div>
      </div>
    </div>`;
  return card;
}

export function updateForecastInfo(state) { /* handled by forecast.js */ }
