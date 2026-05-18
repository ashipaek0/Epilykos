import { fetchDashboardState } from './api.js';

const sparklineCharts = {};
const clockIntervals = {};

const weatherCodeMap = { 0: { icon: 'fi fi-sr-sun', desc: 'Clear Sky' }, 1: { icon: 'fi fi-sr-sun', desc: 'Mainly Clear' }, 2: { icon: 'fi fi-sr-cloud-sun', desc: 'Partly Cloudy' }, 3: { icon: 'fi fi-sr-cloud', desc: 'Overcast' }, 45: { icon: 'fi fi-sr-cloud', desc: 'Fog' }, 48: { icon: 'fi fi-sr-cloud', desc: 'Depositing Rime Fog' }, 51: { icon: 'fi fi-sr-cloud-rain', desc: 'Light Drizzle' }, 53: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Drizzle' }, 55: { icon: 'fi fi-sr-cloud-rain', desc: 'Dense Drizzle' }, 61: { icon: 'fi fi-sr-cloud-rain', desc: 'Slight Rain' }, 63: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Rain' }, 65: { icon: 'fi fi-sr-cloud-rain', desc: 'Heavy Rain' }, 80: { icon: 'fi fi-sr-cloud-rain', desc: 'Rain Showers' } };
const DEFAULT_WEATHER = { icon: 'fi fi-sr-sun', desc: 'Clear Sky' };

function getDayName(d) { return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long' }); }
function setWeatherIconColor(el, desc) {
  const d = (desc || '').toLowerCase();
  if (d.includes('clear') || d.includes('sunny')) el.style.color = '#f59e0b';
  else if (d.includes('partly cloudy')) el.style.color = '#eab308';
  else if (d.includes('cloudy') || d.includes('overcast')) el.style.color = '#9ca3af';
  else if (d.includes('rain') || d.includes('drizzle')) el.style.color = '#3b82f6';
  else if (d.includes('fog')) el.style.color = '#94a3b8';
  else el.style.color = 'var(--text)';
}

export async function updateForecast() {
  const banners = document.querySelectorAll('.forecast-banner-instance');
  if (!banners.length) return;
  let forecastData;
  try { const r = await fetch('/api/solar-forecast'); forecastData = await r.json(); }
  catch (e) { banners.forEach(b => b.style.display = 'none'); return; }
  const data = forecastData;
  if (data.error || !data.daily || !data.daily.length) { banners.forEach(b => b.style.display = 'none'); return; }
  const now = new Date(), todayDate = now.toLocaleDateString('en-CA');
  let ti = data.daily.findIndex(d => d.date === todayDate);
  if (ti === -1) ti = 0;
  const today = data.daily[ti], tomorrow = data.daily[ti + 1] || null, nextDay = data.daily[ti + 2] || null;
  const sevenAM = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0, 0).getTime();
  const historyRes = await fetch('/api/history?days=1');
  const historyData = await historyRes.json();
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const actualColor = '#059669', forecastColor = isDark ? '#fbbf24' : '#d97706';
  const systemCapacityKwp = window.systemCapacityKwp || 2.1;

  for (const banner of banners) {
    const id = banner.dataset.blockId || '';
    banner.style.display = 'block';
    const el = (s) => document.getElementById(id ? `${s}-${id}` : s);
    const setTxt = (s, v) => { const e = el(s); if (e) e.textContent = v || ''; };

    const remaining = today.actual_so_far != null ? Math.max(0, (today.total_kwh || 0) - today.actual_so_far) : (today.total_kwh || 0);
    setTxt('pv-today-value', remaining.toFixed(1) + ' kWh');
    setTxt('pv-today-remaining', 'remaining');
    if (tomorrow) { setTxt('pred-day1-label', getDayName(tomorrow.date)); setTxt('pv-tomorrow', tomorrow.total_kwh.toFixed(1) + ' kWh'); }
    if (nextDay) { setTxt('pred-day2-label', getDayName(nextDay.date)); setTxt('pv-nextday', nextDay.total_kwh.toFixed(1) + ' kWh'); }
    setTxt('forecast-date', now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));

    if (data.weather) {
      const w = data.weather;
      const wi = el('weather-i'); if (wi) { wi.className = w.icon_class || 'fi fi-sr-sun'; setWeatherIconColor(wi, w.desc); }
      setTxt('weather-temp', w.temp != null ? w.temp.toFixed(0) + '°C' : '--°');
      setTxt('weather-desc', w.desc || ''); setTxt('weather-extra', w.extra || '');
      for (let i = 0; i < 2; i++) {
        const col = el(`forecast-weather-${i + 1}`), fwd = (w.forecast_weather || [])[i];
        if (col && fwd && fwd.temp != null) {
          col.style.display = '';
          setTxt(`fcast-heading-${i + 1}`, fwd.day_name || '--');
          const ic = el(`fcast-icon-${i + 1}`); if (ic) { ic.className = fwd.icon_class; setWeatherIconColor(ic, fwd.desc); }
          setTxt(`fcast-temp-${i + 1}`, fwd.temp.toFixed(0) + '°C');
          setTxt(`fcast-desc-${i + 1}`, fwd.desc || ''); setTxt(`fcast-extra-${i + 1}`, fwd.extra || '');
        } else if (col) col.style.display = 'none';
      }
    }

    const clockEl = el('forecast-clock');
    if (clockEl) {
      const cKey = id || '_default';
      if (clockIntervals[cKey]) clearInterval(clockIntervals[cKey]);
      const tick = () => { clockEl.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
      tick(); clockIntervals[cKey] = setInterval(tick, 1000);
    }

    const canvasId = id ? `pv-sparkline-${id}` : 'pv-sparkline';
    const canvas = document.getElementById(canvasId);
    if (!canvas) continue;

    const sparkContainer = canvas.parentElement;
    if (sparkContainer) {
      const rect = sparkContainer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = rect.width * (window.devicePixelRatio || 1);
        canvas.height = rect.height * (window.devicePixelRatio || 1);
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
      }
    }

    if (!sparklineCharts[canvasId]) {
      sparklineCharts[canvasId] = new Chart(canvas.getContext('2d'), {
        type: 'line', data: { datasets: [] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0 } }, scales: { x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'HH' } }, grid: { display: false } }, y: { beginAtZero: true, max: 1 } }, plugins: { tooltip: { enabled: false }, legend: { display: true } } }
      });
    }
    const sc = sparklineCharts[canvasId];

    let actualField = 'solar_kw';
    try { const mm = JSON.parse(banner.dataset.metricMap); if (mm.actual_energy) actualField = mm.actual_energy; } catch (e) {}

    const actualPoints = historyData.filter(d => { const dt = new Date(d.timestamp); return dt.toLocaleDateString('en-CA') === todayDate && dt.getHours() >= 7 && dt.getHours() <= 19; }).map(d => ({ x: d.timestamp, y: d[actualField] ?? 0 }));
    const intervals = []; for (let h = 7; h <= 19; h += 0.5) intervals.push(new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(h), (h % 1) * 60, 0).getTime());
    const abi = {}; actualPoints.forEach(p => { const d = new Date(p.x), bm = Math.floor(d.getMinutes() / 30) * 30, bt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), bm, 0).getTime(); if (!abi[bt]) abi[bt] = []; abi[bt].push(p.y); });
    const actualData = intervals.map(ts => { const vals = abi[ts] || []; if (!vals.length) return null; return { x: ts, y: vals.reduce((a, b) => a + b, 0) / vals.length }; }).filter(p => p !== null && p.x <= now.getTime());

    let fh = (data.hourly || []).filter(h => { const d = new Date(h.period_end); return d.toLocaleDateString('en-CA') === todayDate && d.getHours() >= 7 && d.getHours() <= 19; }).map(h => ({ x: new Date(h.period_end).getTime(), y: h.pv_estimate }));
    if (!fh.length || fh[0].x > sevenAM) fh.unshift({ x: sevenAM, y: 0 });
    fh.sort((a, b) => a.x - b.x);

    sc.data.datasets = [{ label: 'Actual', data: actualData, borderColor: actualColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, borderDash: [] }, { label: 'Forecast', data: fh, borderColor: forecastColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: false, borderDash: [5, 5] }];
    sc.update();
    const ca = sc.chartArea;
    if (ca && sc.data.datasets[0].data.length > 0) {
      const ctx = sc.ctx, grad = ctx.createLinearGradient(0, ca.bottom, 0, ca.top), hx = actualColor;
      const r = parseInt(hx.slice(1, 3), 16), g = parseInt(hx.slice(3, 5), 16), b = parseInt(hx.slice(5, 7), 16);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.1)`); grad.addColorStop(0.5, `rgba(${r},${g},${b},0.3)`); grad.addColorStop(1, `rgba(${r},${g},${b},0.5)`);
      sc.data.datasets[0].backgroundColor = grad; sc.update();
    }
    sc.options.scales.x.min = sevenAM;
    sc.options.scales.x.max = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 0, 0).getTime();
    sc.options.scales.y.max = systemCapacityKwp || undefined;
    sc.options.scales.x.ticks.color = isDark ? '#f8fafc' : '#0f172a';
    sc.options.scales.y.ticks.color = isDark ? '#f8fafc' : '#0f172a';
    sc.options.plugins.legend.labels.color = isDark ? '#f8fafc' : '#0f172a';
    sc.update();
  }
}
