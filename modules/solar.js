const { logger } = require('./logger');
const fetch = require('node-fetch');
const { getConfig, getDb } = require('./database');

let forecastCache = { data: null, timestamp: 0 };
const FORECAST_CACHE_MS = 3 * 60 * 60 * 1000;

function computeSolarForDate(dateStr) {
  const db = getDb();
  const startOfDay = new Date(dateStr + 'T00:00:00');
  const endOfDay = new Date(dateStr + 'T23:59:59');
  const startUnix = Math.floor(startOfDay.getTime() / 1000);
  const endUnix = Math.floor(endOfDay.getTime() / 1000);
  const rows = db.prepare('SELECT timestamp, solar FROM history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);
  if (rows.length < 2) return 0;
  let totalKwh = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const dtHours = (rows[i+1].timestamp - rows[i].timestamp) / 3600;
    const avgKw = (rows[i].solar + rows[i+1].solar) / 2000;
    totalKwh += avgKw * dtHours;
  }
  const last = rows[rows.length-1];
  const dtLastHours = (endUnix - last.timestamp) / 3600;
  if (dtLastHours > 0 && last.timestamp < endUnix) totalKwh += (last.solar / 1000) * dtLastHours;
  return totalKwh;
}

function computeTodaySolar() {
  const db = getDb();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const startUnix = Math.floor(todayStart.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);
  const rows = db.prepare('SELECT timestamp, solar FROM history WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC').all(startUnix, endUnix);
  if (rows.length < 2) return 0;
  let totalKwh = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const dtHours = (rows[i+1].timestamp - rows[i].timestamp) / 3600;
    const avgKw = (rows[i].solar + rows[i+1].solar) / 2000;
    totalKwh += avgKw * dtHours;
  }
  const last = rows[rows.length-1];
  const dtLastHours = (endUnix - last.timestamp) / 3600;
  if (dtLastHours > 0) totalKwh += (last.solar / 1000) * dtLastHours;
  return totalKwh;
}

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

async function getOpenMeteoData(lat, lon, capacityKwp, lossFactor) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation,cloud_cover&timezone=auto&forecast_days=4`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo API error: ${response.status}`);
  const data = await response.json();
  const conversionFactor = (capacityKwp / 1000) * (lossFactor || 0.9);
  const hourly = data.hourly;
  const forecasts = hourly.time.map((t, i) => ({
    period_end: new Date(t).toISOString(),
    pv_estimate: hourly.shortwave_radiation[i] * conversionFactor,
    cloud_cover: hourly.cloud_cover?.[i] ?? null
  }));
  return { forecasts, source: 'open-meteo' };
}

async function getSolarForecast() {
  const forecastEnabled = getConfig('forecast_enabled') === 'true';
  if (!forecastEnabled) return { error: 'Forecast disabled' };

  const now = Date.now();
  if (forecastCache.data && (now - forecastCache.timestamp) < FORECAST_CACHE_MS) {
    const cacheDate = forecastCache.data.daily[0]?.date;
    const todayDate = new Date().toLocaleDateString('en-CA');
    if (cacheDate !== todayDate) forecastCache = { data: null, timestamp: 0 };
    else return forecastCache.data;
  }

  const lat = parseFloat(getConfig('solar_latitude')) || null;
  const lon = parseFloat(getConfig('solar_longitude')) || null;
  const capacityKwp = parseFloat(getConfig('solar_capacity_kwp')) || 0;
  const solcastKey = getConfig('solcast_api_key');
  const resourceId = getConfig('solcast_resource_id');
  const lossFactor = parseFloat(getConfig('solar_loss_factor')) || 0.9;
  const installDate = getConfig('solar_install_date') || '2020-01-01';
  if (capacityKwp <= 0) return { error: 'System capacity not configured' };

  let forecastData = null, source = 'none';

  if (solcastKey) {
    if (resourceId) {
      try {
        const url = `https://api.solcast.com.au/rooftop_sites/${resourceId}/forecasts?format=json&api_key=${solcastKey}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data.forecasts) { forecastData = data.forecasts.map(f => ({ period_end: f.period_end, pv_estimate: f.pv_estimate, cloud_cover: f.cloud_opacity ?? null })); source = 'solcast'; }
        }
      } catch (e) {}
    }
    if (!forecastData && lat && lon) {
      try {
        const tilt = parseFloat(getConfig('solar_tilt')) || 30;
        const azimuth = parseFloat(getConfig('solar_azimuth')) || 180;
        const url = `https://api.solcast.com.au/world_pv_power/forecasts?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&loss_factor=${lossFactor}&install_date=${installDate}&format=json&api_key=${solcastKey}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data.forecasts) { forecastData = data.forecasts.map(f => ({ period_end: f.period_end, pv_estimate: f.pv_estimate, cloud_cover: f.cloud_opacity ?? null })); source = 'solcast'; }
        }
      } catch (e) {}
    }
  }

  if (!forecastData) {
    if (!lat || !lon) return { error: 'Location required for Open-Meteo' };
    try {
      const openMeteo = await getOpenMeteoData(lat, lon, capacityKwp, lossFactor);
      forecastData = openMeteo.forecasts;
      source = openMeteo.source;
    } catch (e) { return { error: 'All forecast sources unavailable' }; }
  }

  const actualTodayKwh = computeTodaySolar();
  const dailyMap = new Map();
  forecastData.forEach(f => {
    const date = f.period_end.split('T')[0];
    const existing = dailyMap.get(date) || { date, total_kwh: 0, peak_kw: 0, source };
    existing.total_kwh += f.pv_estimate;
    existing.peak_kw = Math.max(existing.peak_kw, f.pv_estimate);
    dailyMap.set(date, existing);
  });
  const daily = Array.from(dailyMap.values()).slice(0, 4);
  const todayDate = new Date().toLocaleDateString('en-CA');
  for (const dayEntry of daily) if (dayEntry.date === todayDate) dayEntry.actual_so_far = actualTodayKwh;

  const hourly = forecastData.slice(0, 96);
  const result = { daily, hourly, source };

  // Weather data
  if (lat && lon) {
    try {
      const currentUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relativehumidity_2m,apparent_temperature&timezone=auto&forecast_days=1`;
      const currentRes = await fetch(currentUrl);
      let temp = null, feelsLike = null, humidity = null, iconClass = DEFAULT_WEATHER.icon, weatherDesc = DEFAULT_WEATHER.desc;
      if (currentRes.ok) {
        const currentData = await currentRes.json();
        const cw = currentData.current_weather;
        temp = cw.temperature;
        const code = cw.weathercode;
        const mapping = weatherCodeMap[code] || DEFAULT_WEATHER;
        iconClass = mapping.icon; weatherDesc = mapping.desc;
        const hourlyData = currentData.hourly;
        const times = hourlyData.time.map(t => new Date(t));
        for (let i = 0; i < times.length; i++) {
          if (times[i].getHours() === new Date().getHours()) {
            feelsLike = hourlyData.apparent_temperature[i];
            humidity = hourlyData.relativehumidity_2m[i];
            break;
          }
        }
      }
      let forecastWeather = [];
      const dailyWeatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,apparent_temperature_max,relativehumidity_2m_mean&timezone=auto&forecast_days=3`;
      const dailyWeatherRes = await fetch(dailyWeatherUrl);
      if (dailyWeatherRes.ok) {
        const dailyData = await dailyWeatherRes.json();
        const dates = dailyData.daily.time;
        const codes = dailyData.daily.weathercode;
        const temps = dailyData.daily.temperature_2m_max;
        const feels = dailyData.daily.apparent_temperature_max;
        const humids = dailyData.daily.relativehumidity_2m_mean;
        for (let i = 1; i <= 2 && i < dates.length; i++) {
          const mapping = weatherCodeMap[codes[i]] || DEFAULT_WEATHER;
          const d = new Date(dates[i] + 'T12:00:00');
          forecastWeather.push({
            date: dates[i],
            day_name: d.toLocaleDateString('en-US', { weekday: 'long' }),
            icon_class: mapping.icon,
            desc: mapping.desc,
            temp: temps[i],
            extra: (feels[i] != null ? `Feels ${feels[i].toFixed(0)}°C` : '') + (humids[i] != null ? ` · Humidity ${humids[i].toFixed(0)}%` : '')
          });
        }
      }
      result.weather = {
        icon_class: iconClass, desc: weatherDesc, temp,
        extra: (feelsLike != null ? `Feels ${feelsLike.toFixed(0)}°C` : '') + (humidity != null ? ` · Humidity ${humidity}%` : ''),
        forecast_weather: forecastWeather
      };
    } catch (e) {
      result.weather = { icon_class: DEFAULT_WEATHER.icon, desc: DEFAULT_WEATHER.desc, temp: null, extra: '', forecast_weather: [] };
    }
  } else {
    result.weather = { icon_class: DEFAULT_WEATHER.icon, desc: DEFAULT_WEATHER.desc, temp: null, extra: '', forecast_weather: [] };
  }

  forecastCache = { data: result, timestamp: now };
  return result;
}

async function testForecast() {
  const lat = parseFloat(getConfig('solar_latitude')), lon = parseFloat(getConfig('solar_longitude'));
  const capacityKwp = parseFloat(getConfig('solar_capacity_kwp'));
  if (isNaN(lat) || isNaN(lon) || isNaN(capacityKwp) || capacityKwp <= 0) throw new Error('Invalid location or capacity');
  const solcastKey = getConfig('solcast_api_key');
  const resourceId = getConfig('solcast_resource_id');
  const tilt = parseFloat(getConfig('solar_tilt')) || 30;
  const azimuth = parseFloat(getConfig('solar_azimuth')) || 180;
  const lossFactor = parseFloat(getConfig('solar_loss_factor')) || 0.9;
  const installDate = getConfig('solar_install_date') || '2020-01-01';
  let source = 'none', dailyTotal = 0, peak = 0;

  if (solcastKey) {
    if (resourceId) {
      try {
        const url = `https://api.solcast.com.au/rooftop_sites/${resourceId}/forecasts?format=json&api_key=${solcastKey}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const today = new Date().toISOString().split('T')[0];
          (data.forecasts || []).forEach(f => { if (f.period_end.startsWith(today)) { dailyTotal += f.pv_estimate; peak = Math.max(peak, f.pv_estimate); } });
          source = 'solcast';
        }
      } catch (e) {}
    }
    if (source === 'none') {
      try {
        const url = `https://api.solcast.com.au/world_pv_power/forecasts?latitude=${lat}&longitude=${lon}&capacity=${capacityKwp}&tilt=${tilt}&azimuth=${azimuth}&loss_factor=${lossFactor}&install_date=${installDate}&format=json&api_key=${solcastKey}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const today = new Date().toISOString().split('T')[0];
          (data.forecasts || []).forEach(f => { if (f.period_end.startsWith(today)) { dailyTotal += f.pv_estimate; peak = Math.max(peak, f.pv_estimate); } });
          source = 'solcast';
        }
      } catch (e) {}
    }
  }
  if (source === 'none') {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&timezone=auto&forecast_days=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const conversionFactor = (capacityKwp / 1000) * lossFactor;
      const today = new Date().toISOString().split('T')[0];
      data.hourly.time.forEach((t, i) => {
        if (t.startsWith(today)) {
          const pv = data.hourly.shortwave_radiation[i] * conversionFactor;
          dailyTotal += pv; peak = Math.max(peak, pv);
        }
      });
      source = 'open-meteo';
    } catch (e) { throw new Error('Forecast service unavailable'); }
  }
  return { source, today_estimate_kwh: dailyTotal.toFixed(2), peak_kw: peak.toFixed(2) };
}

module.exports = { computeSolarForDate, computeTodaySolar, getSolarForecast, testForecast, weatherCodeMap, DEFAULT_WEATHER };
