/**
 * Solar Forecast Engine
 *
 * Fetches /api/solar-forecast and renders sparkline charts, weather, and forecast days
 * for all forecast block types: full banner, sparkline-only card, and info card.
 *
 * Sparkline: Chart.js line chart comparing actual power vs predicted, 7am-7pm.
 * Uses 30-minute bucketing for smoothing. Green gradient fill on actual line.
 * Configurable actual-energy field per block (default: solar_kw).
 *
 * Multi-instance: charts stored in sparklineCharts Map keyed by canvas ID.
 *
 * @module forecast
 */
import { fetchDashboardState } from './api.js';
import { updatePvToday } from './components/pvToday.js';

const sparklineCharts = {};
export function clearSparklineCharts() {
  Object.values(sparklineCharts).forEach(c => c.destroy());
  for (const k in sparklineCharts) delete sparklineCharts[k];
}
const clockIntervals = {};

const weatherCodeMap = { 0: { icon: 'fi fi-sr-sun', desc: 'Clear Sky' }, 1: { icon: 'fi fi-sr-sun', desc: 'Mainly Clear' }, 2: { icon: 'fi fi-sr-cloud-sun', desc: 'Partly Cloudy' }, 3: { icon: 'fi fi-sr-cloud', desc: 'Overcast' }, 45: { icon: 'fi fi-sr-cloud', desc: 'Fog' }, 48: { icon: 'fi fi-sr-cloud', desc: 'Depositing Rime Fog' }, 51: { icon: 'fi fi-sr-cloud-rain', desc: 'Light Drizzle' }, 53: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Drizzle' }, 55: { icon: 'fi fi-sr-cloud-rain', desc: 'Dense Drizzle' }, 61: { icon: 'fi fi-sr-cloud-rain', desc: 'Slight Rain' }, 63: { icon: 'fi fi-sr-cloud-rain', desc: 'Moderate Rain' }, 65: { icon: 'fi fi-sr-cloud-rain', desc: 'Heavy Rain' }, 80: { icon: 'fi fi-sr-cloud-rain', desc: 'Rain Showers' } };
const DEFAULT_WEATHER = { icon: 'fi fi-sr-sun', desc: 'Clear Sky' };

function getDayName(d) { return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long' }); }
function setWeatherIconColor(el, desc) {
  const d = (desc || '').toLowerCase();
  if (d.includes('clear') || d.includes('sunny')) el.style.color = '#f59e0b';
  else if (d.includes('partly cloudy')) el.style.color = '#eab308';
  else if (d.includes('cloudy') || d.includes('overcast')) el.style.color = '#9ca3af';
  else if (d.includes('rain') || d.includes('drizzle')) el.style.color = '#87aec8';
  else if (d.includes('fog')) el.style.color = '#94a3b8';
  else el.style.color = 'var(--text)';
}

export async function updateForecast() {
  const banners = document.querySelectorAll('.forecast-banner-instance');
  const infoCards = document.querySelectorAll('.forecast-info-instance');
  const sparkCards = document.querySelectorAll('.forecast-sparkline-instance');
  const pvTodayCards = document.querySelectorAll('.pv-today-instance');
  if (!banners.length && !infoCards.length && !sparkCards.length && !pvTodayCards.length) return;
  let forecastData;
  try { const r = await fetch('/api/solar-forecast'); forecastData = await r.json(); }
  catch (e) { banners.forEach(b => b.style.display = 'none'); return; }
  const data = forecastData;
  const source = data.source || 'unknown';
  document.querySelectorAll('.forecast-source').forEach(el => { el.textContent = source === 'solcast' ? 'Solcast' : source === 'open-meteo' ? 'Open-Meteo' : ''; });

  if (data.error || !data.daily || !data.daily.length) {
    banners.forEach(b => b.style.display = 'none');
    infoCards.forEach(b => b.style.display = 'none');
    sparkCards.forEach(b => b.style.display = 'none');
    return;
  }

  const now = new Date(), todayDate = now.toLocaleDateString('en-CA');
  let ti = data.daily.findIndex(d => d.date === todayDate);
  if (ti === -1) ti = 0;
  const today = data.daily[ti], tomorrow = data.daily[ti + 1] || null, nextDay = data.daily[ti + 2] || null;
  const sevenAM = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0, 0).getTime();
  const historyRes = await fetch('/api/history?days=1');
  const historyData = await historyRes.json();
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const actualColor = '#f59e0b', forecastColor = '#d97706';
  const systemCapacityKwp = window.systemCapacityKwp || 2.1;

  for (const banner of banners) {
    const id = banner.dataset.blockId || '';
    banner.style.display = 'block';
    const el = (s) => document.getElementById(id ? `${s}-${id}` : s);
    const setTxt = (s, v) => { const e = el(s); if (e) e.textContent = v || ''; };

    // Remaining: sum forecast from now until end of today, not total - actual
    const nowMs = Date.now();
    const remainingTodayKwh = (data.hourly || [])
      .filter(h => new Date(h.period_end).getTime() > nowMs && new Date(h.period_end).toLocaleDateString('en-CA') === todayDate)
      .reduce((sum, h) => sum + (h.pv_estimate || 0), 0);
    setTxt('pv-today-value', remainingTodayKwh.toFixed(1) + ' kWh');
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
    const pointsForToday = historyData.filter(d => { const dt = new Date(d.timestamp); return dt.toLocaleDateString('en-CA') === todayDate && dt.getHours() >= 6 && dt.getHours() <= 20; });
    const actualData = computeActualCurve(pointsForToday, actualField, now);
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

  // Forecast info cards (weather + days, no sparkline)
  document.querySelectorAll('.forecast-info-instance').forEach(card => {
    const id = card.dataset.blockId || '';
    card.style.display = 'block';
    const el = (s) => document.getElementById(id ? `${s}-${id}` : s);
    const setTxt = (s, v) => { const e = el(s); if (e) e.textContent = v || ''; };
    setTxt('fi-date', now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));
    const clockEl = el('fi-clock');
    if (clockEl) { clockEl.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    const remainingTodayKwh = (data.hourly || [])
      .filter(h => new Date(h.period_end).getTime() > Date.now() && new Date(h.period_end).toLocaleDateString('en-CA') === todayDate)
      .reduce((sum, h) => sum + (h.pv_estimate || 0), 0);
    setTxt('fi-today-value', remainingTodayKwh.toFixed(1) + ' kWh');
    setTxt('fi-today-remaining', 'remaining');
    if (tomorrow) { setTxt('fi-day1-label', getDayName(tomorrow.date)); setTxt('fi-tomorrow', tomorrow.total_kwh.toFixed(1) + ' kWh'); }
    if (nextDay) { setTxt('fi-day2-label', getDayName(nextDay.date)); setTxt('fi-nextday', nextDay.total_kwh.toFixed(1) + ' kWh'); }
    if (data.weather) {
      const w = data.weather;
      const wi = el('fi-weather-i'); if (wi) { wi.className = w.icon_class || 'fi fi-sr-sun'; setWeatherIconColor(wi, w.desc); }
      setTxt('fi-weather-temp', w.temp != null ? w.temp.toFixed(0) + '°C' : '--°');
      setTxt('fi-weather-desc', w.desc || ''); setTxt('fi-weather-extra', w.extra || '');
      for (let i = 0; i < 2; i++) {
        const col = el(`fi-weather-${i + 1}`), fwd = (w.forecast_weather || [])[i];
        if (col && fwd && fwd.temp != null) {
          col.style.display = '';
          setTxt(`fi-fcast-heading-${i + 1}`, fwd.day_name || '--');
          const ic = el(`fi-fcast-icon-${i + 1}`); if (ic) { ic.className = fwd.icon_class; setWeatherIconColor(ic, fwd.desc); }
          setTxt(`fi-fcast-temp-${i + 1}`, fwd.temp.toFixed(0) + '°C');
          setTxt(`fi-fcast-desc-${i + 1}`, fwd.desc || ''); setTxt(`fi-fcast-extra-${i + 1}`, fwd.extra || '');
        } else if (col) col.style.display = 'none';
      }
    }
  });

  // Forecast sparkline cards (graph only) — identical logic to banner sparkline above
  for (const card of document.querySelectorAll('.forecast-sparkline-instance')) {
    const id = card.dataset.blockId || '';
    const canvasId = id ? `fc-sparkline-${id}` : 'fc-sparkline';
    const canvas = document.getElementById(canvasId);
    if (!canvas) continue;

    const sparkContainer = canvas.parentElement;
    if (sparkContainer) {
      const rect = sparkContainer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = rect.width * (window.devicePixelRatio || 1);
        canvas.height = rect.height * (window.devicePixelRatio || 1);
      }
    }

    if (!sparklineCharts[canvasId]) {
      sparklineCharts[canvasId] = new Chart(canvas.getContext('2d'), {
        type: 'line', data: { datasets: [] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0 } }, scales: { x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'HH' } }, grid: { display: false } }, y: { beginAtZero: true, max: 1 } }, plugins: { tooltip: { enabled: false }, legend: { display: true } } }
      });
    }
    const sc = sparklineCharts[canvasId];

    let sField = 'solar_kw';
    try { const mm = JSON.parse(card.dataset.metricMap); if (mm.actual_energy) sField = mm.actual_energy; } catch (e) {}

    const pts = historyData.filter(d => { const dt = new Date(d.timestamp); return dt.toLocaleDateString('en-CA') === todayDate && dt.getHours() >= 6 && dt.getHours() <= 20; });
    const sActual = computeActualCurve(pts, sField, now);

    let fh2 = (data.hourly || []).filter(h => { const d = new Date(h.period_end); return d.toLocaleDateString('en-CA') === todayDate && d.getHours() >= 7 && d.getHours() <= 19; }).map(h => ({ x: new Date(h.period_end).getTime(), y: h.pv_estimate }));
    if (!fh2.length || fh2[0].x > sevenAM) fh2.unshift({ x: sevenAM, y: 0 });
    fh2.sort((a, b) => a.x - b.x);

    sc.data.datasets = [{ label: 'Actual', data: sActual, borderColor: actualColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, borderDash: [] }, { label: 'Forecast', data: fh2, borderColor: forecastColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: false, borderDash: [5, 5] }];
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

  // PV Today cards
  if (document.querySelectorAll('.pv-today-instance').length) {
    updatePvToday(data);
  }
}

/** Shared actual-curve computation used by both banner and standalone sparklines. */
function computeActualCurve(pointsForToday, actualField, now) {
  const intervals = []; for (let h = 7; h <= 19; h += 0.5) intervals.push(new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(h), (h % 1) * 60, 0).getTime());
  const hasInstantKw = pointsForToday.some(d => (d[actualField] || 0) > 0);
  if (hasInstantKw) {
    const bins = {}; pointsForToday.forEach(p => { const d = new Date(p.timestamp), bm = Math.floor(d.getMinutes() / 30) * 30, bt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), bm, 0).getTime(); if (!bins[bt]) bins[bt] = []; bins[bt].push(p[actualField] || 0); });
    return intervals.map(ts => { const vals = bins[ts] || []; if (!vals.length) return null; return { x: ts, y: vals.reduce((a, b) => a + b, 0) / vals.length }; }).filter(p => p !== null && p.x <= now.getTime());
  }
  // Derive hourly kW from daily_solar kWh increments
  const dailySolarPoints = pointsForToday.filter(d => d.daily_solar != null).sort((a, b) => a.timestamp - b.timestamp);
  if (dailySolarPoints.length >= 1 && dailySolarPoints[0].daily_solar > 0) {
    const sunrise = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0);
    dailySolarPoints.unshift({ timestamp: Math.floor(sunrise.getTime() / 1000), daily_solar: 0 });
  }
  if (dailySolarPoints.length >= 2) {
    return intervals.map(ts => {
      const t = ts / 1000;
      let prev = null; for (let i = dailySolarPoints.length - 1; i >= 0; i--) { if (dailySolarPoints[i].timestamp / 1000 <= t) { prev = dailySolarPoints[i]; break; } }
      const next = dailySolarPoints.find(p => p.timestamp / 1000 > t);
      if (!prev || !next) return null;
      const dtHours = (next.timestamp / 1000 - prev.timestamp / 1000) / 3600;
      if (dtHours <= 0) return null;
      return { x: ts, y: Math.max(0, ((next.daily_solar - prev.daily_solar) / dtHours) || 0) };
    }).filter(p => p !== null && p.x <= now.getTime());
  }
  return [];
}
