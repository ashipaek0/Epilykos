export function buildWeatherBlock(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'weather-block card';
  container.style.background = 'var(--card-bg)';
  container.style.borderRadius = 'var(--radius)';
  container.style.padding = '1rem';
  container.style.boxShadow = 'var(--shadow)';
  container.style.border = '1px solid var(--border)';
  
  container.innerHTML = `
    <div class="weather-block-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
      <h3 style="margin:0;">${escapeHtml(config.title || 'Weather')}</h3>
      <span class="weather-last-updated" style="font-size: 0.7rem; opacity:0.6;">--</span>
    </div>
    <div class="weather-block-current" style="display: flex; align-items: center; gap: 1rem;">
      <div class="weather-icon" style="font-size: 2rem;"><i class="fi fi-sr-sun"></i></div>
      <div class="weather-temp" style="font-size: 1.5rem; font-weight: bold;">--°C</div>
      <div class="weather-desc">--</div>
    </div>
    <div class="weather-extra" style="font-size: 0.8rem; margin-top: 0.5rem;">Feels like --°C · Humidity --%</div>
    <div class="weather-forecast" style="display: flex; gap: 1rem; margin-top: 0.75rem; flex-wrap: wrap;">
      <!-- forecast days will be injected -->
    </div>
  `;
  return container;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export async function updateWeatherBlock(state) {
  const container = document.querySelector('.weather-block');
  if (!container) return;
  try {
    const res = await fetch('/api/solar-forecast');
    const data = await res.json();
    if (data.error || !data.weather) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'block';
    const w = data.weather;
    const lastUpdated = new Date().toLocaleTimeString();
    container.querySelector('.weather-last-updated').textContent = `Updated ${lastUpdated}`;
    container.querySelector('.weather-icon i').className = w.icon_class || 'fi fi-sr-sun';
    container.querySelector('.weather-temp').textContent = w.temp != null ? `${w.temp.toFixed(0)}°C` : '--°C';
    container.querySelector('.weather-desc').textContent = w.desc || '';
    container.querySelector('.weather-extra').textContent = w.extra || '';
    
    const forecastContainer = container.querySelector('.weather-forecast');
    forecastContainer.innerHTML = '';
    (w.forecast_weather || []).slice(0, 2).forEach(day => {
      const dayDiv = document.createElement('div');
      dayDiv.className = 'weather-forecast-day';
      dayDiv.style.textAlign = 'center';
      dayDiv.style.minWidth = '80px';
      dayDiv.innerHTML = `
        <div class="forecast-day-name" style="font-weight:bold;">${day.day_name}</div>
        <div class="forecast-icon"><i class="${day.icon_class}"></i></div>
        <div class="forecast-temp">${day.temp.toFixed(0)}°C</div>
        <div class="forecast-desc" style="font-size:0.7rem;">${day.desc}</div>
      `;
      forecastContainer.appendChild(dayDiv);
    });
  } catch (err) {
    console.error('Weather block error:', err);
    container.style.display = 'none';
  }
}
