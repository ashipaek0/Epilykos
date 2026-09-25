/**
 * Canned Open-Meteo response in the shape modules/solar.js requests: ONE call
 * returning current + hourly + daily blocks. Times are local wall-clock
 * strings (no offset) so fixtures are deterministic in any time zone.
 * Weather values: current 15 °C / feels 14 / humidity 20 % (deliberately
 * different from the Solcast fixtures so provider precedence is observable).
 */
'use strict';
const { localDateString } = require('../modules/localTime');

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateString(d);
}

function openMeteoPayload() {
  const today = localDateString();
  const pad = (n) => String(n).padStart(2, '0');
  const nowHour = `${today}T${pad(new Date().getHours())}:00`;
  return {
    utc_offset_seconds: 0,
    timezone: 'Etc/Test',
    current: {
      time: nowHour, temperature_2m: 15, apparent_temperature: 14, relative_humidity_2m: 20,
      weather_code: 0, is_day: 1, cloud_cover: 10, wind_speed_10m: 3.2, wind_direction_10m: 225,
      wind_gusts_10m: 6.1, precipitation: 0, pressure_msl: 1013.2, uv_index: 5.5
    },
    hourly: {
      time: [`${today}T10:00`, `${today}T11:00`, nowHour],
      temperature_2m: [26, 27, 28], apparent_temperature: [27, 28, 14], relative_humidity_2m: [60, 58, 20],
      dew_point_2m: [18, 18, 17], precipitation_probability: [5, 10, 15], precipitation: [0, 0, 0],
      weather_code: [1, 2, 0], cloud_cover: [10, 20, 10], wind_speed_10m: [2, 3, 3.2],
      wind_direction_10m: [200, 210, 225], wind_gusts_10m: [4, 5, 6.1],
      shortwave_radiation: [800, 900, 200], uv_index: [6, 7, 5.5], is_day: [1, 1, 1]
    },
    daily: {
      time: [today, dayOffset(1), dayOffset(2)],
      weather_code: [0, 1, 95], temperature_2m_max: [15, 16, 17], temperature_2m_min: [9, 10, 11],
      apparent_temperature_max: [14, 15, 16], apparent_temperature_min: [8, 9, 10],
      precipitation_sum: [0, 0.4, 12], precipitation_probability_max: [5, 20, 80],
      wind_speed_10m_max: [4, 5, 9], wind_gusts_10m_max: [7, 8, 15], wind_direction_10m_dominant: [220, 180, 270],
      uv_index_max: [6, 5, 3], sunrise: [`${today}T06:40`, `${dayOffset(1)}T06:41`, `${dayOffset(2)}T06:41`],
      sunset: [`${today}T18:45`, `${dayOffset(1)}T18:44`, `${dayOffset(2)}T18:44`],
      shortwave_radiation_sum: [20, 18, 9], daylight_duration: [43500, 43400, 43380]
    }
  };
}

module.exports = { openMeteoPayload };
