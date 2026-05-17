import { fetchDashboardState } from './api.js';

let sparklineChart = null;
const weatherCodeMap = {
  0: { icon: 'fi fi-sr-sun', desc: 'Clear Sky' },
  1: { icon: 'fi fi-sr-sun', desc: 'Mainly Clear' },
  2: { icon: 'fi fi-sr-cloud-sun', desc: 'Partly Cloudy' },
  3: { icon: 'fi fi-sr-cloud', desc: 'Overcast' },
  45: { icon: 'fi fi-sr-cloud', desc: 'Fog' },
  48: { icon: 'fi fi-sr-cloud', desc: 'Depositing Rime Fog' },
  51: { icon: 'fi fi-sr-cloud-rain', desc: 'Light Drizzle' },
  53: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Drizzle' },
  55: { icon: 'fi fi-sr-cloud-rain', desc: 'Dense Drizzle' },
  61: { icon: 'fi fi-sr-cloud-rain', desc: 'Slight Rain' },
  63: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Rain' },
  65: { icon: 'fi fi-sr-cloud-rain', desc: 'Heavy Rain' },
  80: { icon: 'fi fi-sr-cloud-rain', desc: 'Rain Showers' }
};
const DEFAULT_WEATHER = { icon: 'fi fi-sr-sun', desc: 'Clear Sky' };

function getDayName(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}

function setWeatherIconColor(iconEl, desc) {
  const descLower = (desc || '').toLowerCase();
  if (descLower.includes('clear') || descLower.includes('sunny')) iconEl.style.color = '#f59e0b';
  else if (descLower.includes('partly cloudy')) iconEl.style.color = '#eab308';
  else if (descLower.includes('cloudy') || descLower.includes('overcast')) iconEl.style.color = '#9ca3af';
  else if (descLower.includes('rain') || descLower.includes('drizzle')) iconEl.style.color = '#3b82f6';
  else if (descLower.includes('fog')) iconEl.style.color = '#94a3b8';
  else iconEl.style.color = 'var(--text)';
}

let clockInterval = null;

function startClock() {
  const el = document.getElementById('forecast-clock');
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(tick, 1000);
}

export async function updateForecast() {
  const banner = document.getElementById('forecast-banner');
  if (!banner) return;
  try {
    startClock();
    const res = await fetch('/api/solar-forecast');
    const data = await res.json();
    if (data.error || !data.daily || data.daily.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'block';

    const now = new Date();
    const todayDate = now.toLocaleDateString('en-CA');
    let todayIdx = data.daily.findIndex(d => d.date === todayDate);
    if (todayIdx === -1) todayIdx = 0;
    const today = data.daily[todayIdx];
    const tomorrow = data.daily[todayIdx + 1] || null;
    const nextDay = data.daily[todayIdx + 2] || null;

    // Show remaining today (total minus actual so far)
    const remaining = today.actual_so_far != null
      ? Math.max(0, (today.total_kwh || 0) - today.actual_so_far)
      : (today.total_kwh || 0);
    document.getElementById('pv-today-value').textContent = remaining.toFixed(1) + ' kWh';

    const remainingEl = document.getElementById('pv-today-remaining');
    if (remainingEl) {
      remainingEl.textContent = 'remaining';
    }

    if (tomorrow) {
      document.getElementById('pred-day1-label').textContent = getDayName(tomorrow.date);
      document.getElementById('pv-tomorrow').textContent = tomorrow.total_kwh.toFixed(1) + ' kWh';
    } else {
      document.getElementById('pred-day1-label').textContent = '--';
      document.getElementById('pv-tomorrow').textContent = '-- kWh';
    }
    if (nextDay) {
      document.getElementById('pred-day2-label').textContent = getDayName(nextDay.date);
      document.getElementById('pv-nextday').textContent = nextDay.total_kwh.toFixed(1) + ' kWh';
    } else {
      document.getElementById('pred-day2-label').textContent = '--';
      document.getElementById('pv-nextday').textContent = '-- kWh';
    }
    document.getElementById('forecast-date').textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    if (data.weather) {
      const w = data.weather;
      document.getElementById('weather-i').className = w.icon_class || 'fi fi-sr-sun';
      document.getElementById('weather-temp').textContent = w.temp != null ? w.temp.toFixed(0) + '°C' : '--°';
      document.getElementById('weather-desc').textContent = w.desc || '';
      document.getElementById('weather-extra').textContent = w.extra || '';
      setWeatherIconColor(document.getElementById('weather-i'), w.desc);

      const forecastWeather = w.forecast_weather || [];
      const col1 = document.getElementById('forecast-weather-1');
      const fw1 = forecastWeather[0];
      if (fw1 && fw1.temp != null) {
        document.getElementById('fcast-heading-1').textContent = fw1.day_name || '--';
        document.getElementById('fcast-icon-1').className = fw1.icon_class;
        document.getElementById('fcast-temp-1').textContent = fw1.temp.toFixed(0) + '°C';
        document.getElementById('fcast-desc-1').textContent = fw1.desc || '';
        document.getElementById('fcast-extra-1').textContent = fw1.extra || '';
        setWeatherIconColor(document.getElementById('fcast-icon-1'), fw1.desc);
        col1.style.display = '';
      } else {
        col1.style.display = 'none';
      }

      const col2 = document.getElementById('forecast-weather-2');
      const fw2 = forecastWeather[1];
      if (fw2 && fw2.temp != null) {
        document.getElementById('fcast-heading-2').textContent = fw2.day_name || '--';
        document.getElementById('fcast-icon-2').className = fw2.icon_class;
        document.getElementById('fcast-temp-2').textContent = fw2.temp.toFixed(0) + '°C';
        document.getElementById('fcast-desc-2').textContent = fw2.desc || '';
        document.getElementById('fcast-extra-2').textContent = fw2.extra || '';
        setWeatherIconColor(document.getElementById('fcast-icon-2'), fw2.desc);
        col2.style.display = '';
      } else {
        col2.style.display = 'none';
      }
    }

    const canvasSpark = document.getElementById('pv-sparkline');
    if (canvasSpark) {
      if (!sparklineChart) {
        const ctx = canvasSpark.getContext('2d');
        sparklineChart = new Chart(ctx, {
          type: 'line',
          data: { datasets: [] },
          options: {
            responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' },
            elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0 } },
            scales: {
              x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'HH' } }, grid: { display: false } },
              y: { beginAtZero: true, max: 1 }
            },
            plugins: { tooltip: { enabled: false }, legend: { display: true } }
          }
        });
      }

      // Read configured actual-energy field from container, default to solar_kw
      let actualField = 'solar_kw';
      try {
        const metricMap = JSON.parse(banner.dataset.metricMap);
        if (metricMap.actual_energy) actualField = metricMap.actual_energy;
      } catch (e) { /* use default */ }

      const historyRes = await fetch('/api/history?days=1');
      const historyData = await historyRes.json();
      const actualPoints = historyData
        .filter(d => {
          const date = new Date(d.timestamp);
          return date.toLocaleDateString('en-CA') === todayDate && date.getHours() >= 7 && date.getHours() <= 19;
        })
        .map(d => ({ x: d.timestamp, y: d[actualField] ?? 0 }));

      // 30-minute bucketing from working version — properly averages and handles zeros
      const intervals = [];
      for (let h = 7; h <= 19; h += 0.5) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(h), (h % 1) * 60, 0);
        intervals.push(start.getTime());
      }
      const actualByInterval = {};
      actualPoints.forEach(p => {
        const d = new Date(p.x);
        const bucketMinute = Math.floor(d.getMinutes() / 30) * 30;
        const bucketTime = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), bucketMinute, 0).getTime();
        if (!actualByInterval[bucketTime]) actualByInterval[bucketTime] = [];
        actualByInterval[bucketTime].push(p.y);
      });
      const actualData = intervals.map(ts => {
        const values = actualByInterval[ts] || [];
        if (values.length === 0) return null;
        return { x: ts, y: values.reduce((a,b) => a+b, 0) / values.length };
      }).filter(p => p !== null && p.x <= now.getTime());

      let forecastHourly = (data.hourly || [])
        .filter(h => {
          const d = new Date(h.period_end);
          return d.toLocaleDateString('en-CA') === todayDate && d.getHours() >= 7 && d.getHours() <= 19;
        })
        .map(h => ({ x: new Date(h.period_end).getTime(), y: h.pv_estimate }));

      const sevenAM = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7,0,0).getTime();
      if (forecastHourly.length === 0 || forecastHourly[0].x > sevenAM) {
        forecastHourly.unshift({ x: sevenAM, y: 0 });
      }
      forecastHourly.sort((a,b) => a.x - b.x);

      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const actualColor = '#3b82f6';
      const forecastColor = isDark ? '#fbbf24' : '#d97706';

      sparklineChart.data.datasets = [
        { label: 'Actual', data: actualData, borderColor: actualColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: false, borderDash: [] },
        { label: 'Forecast', data: forecastHourly, borderColor: forecastColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, borderDash: [5,5] }
      ];
      sparklineChart.update();

      const chartArea = sparklineChart.chartArea;
      if (chartArea && sparklineChart.data.datasets[1].data.length > 0) {
        const ctx = sparklineChart.ctx;
        const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
        const hex = forecastColor;
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        gradient.addColorStop(0, `rgba(${r},${g},${b},0.1)`);
        gradient.addColorStop(0.5, `rgba(${r},${g},${b},0.3)`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0.5)`);
        sparklineChart.data.datasets[1].backgroundColor = gradient;
        sparklineChart.update();
      }

      sparklineChart.options.scales.x.min = sevenAM;
      sparklineChart.options.scales.x.max = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19,0,0).getTime();
      const systemCapacityKwp = window.systemCapacityKwp || 2.1;
      sparklineChart.options.scales.y.max = systemCapacityKwp || undefined;
      sparklineChart.options.scales.x.ticks.color = isDark ? '#f8fafc' : '#0f172a';
      sparklineChart.options.scales.y.ticks.color = isDark ? '#f8fafc' : '#0f172a';
      sparklineChart.options.plugins.legend.labels.color = isDark ? '#f8fafc' : '#0f172a';
      sparklineChart.update();
    }
  } catch (e) {
    console.error('Forecast error:', e);
    banner.style.display = 'none';
  }
}
