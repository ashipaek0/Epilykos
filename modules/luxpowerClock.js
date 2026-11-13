'use strict';
/**
 * The LuxPower inverter's clock, from its holding registers 12 to 14, and how far it is from the server's clock.
 *
 * The inverter's charge and discharge windows follow its own clock, which is plain wall-clock time with no timezone. Whether
 * it follows daylight saving depends on what set it, and a power loss can leave it wrong, so a skewed clock shows up as
 * schedules that run at the wrong time. Epilykos reads the clock with the rest of the settings (no extra request) and
 * publishes it as text (`inverter_time`) and as its difference from the server's time in seconds (`inverter_clock_skew`,
 * positive when the inverter is ahead).
 *
 * Each register packs two fields, low byte first: year-2000 | month << 8, day | hour << 8, minute | second << 8.
 *
 * The clock has no zone of its own, so it is read in the server's zone. In the hour that is repeated when the clocks go back
 * the same wall-clock time occurs twice, and the reading is taken as the one nearer to now, so a correct clock does not look
 * an hour slow. The cost is the hour that is skipped when the clocks go forward: an inverter that has not moved forward yet
 * looks correct for that one hour.
 *
 * @module luxpowerClock
 */

const pad = n => String(n).padStart(2, '0');

/**
 * Decode the three words and compare with `nowMs`. Returns { text, skewSeconds } or null when a word is missing or the
 * fields are not a real date (what an inverter that has not started up fully reports).
 */
function decodeInverterClock(words, nowMs = Date.now()) {
  if (!Array.isArray(words) || words.length < 3 || words.slice(0, 3).some(w => !Number.isInteger(w) || w < 0 || w > 0xFFFF)) return null;
  const [ym, dh, ms] = words;
  const year = 2000 + (ym & 0xFF), month = ym >> 8, day = dh & 0xFF, hour = dh >> 8, minute = ms & 0xFF, second = ms >> 8;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  // The offsets the server's zone can have around now: the wall-clock time is an instant at each. Only an instant that really
  // has that offset is a time that happened (03:35 on the morning the clocks go back is not a CEST time any more), and of those
  // the nearer to now is the clock. When none did (a time in the hour that is skipped) the nearer of all is used.
  const offsets = [...new Set([new Date(nowMs - 12 * 3600000).getTimezoneOffset(), new Date(nowMs + 12 * 3600000).getTimezoneOffset()])];
  const instants = offsets.map(minutes => ({ at: wall + minutes * 60000, minutes }));
  const real = instants.filter(c => new Date(c.at).getTimezoneOffset() === c.minutes);
  let best = null;
  for (const c of (real.length ? real : instants)) if (best === null || Math.abs(c.at - nowMs) < Math.abs(best - nowMs)) best = c.at;
  return {
    text: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
    skewSeconds: Math.round((best - nowMs) / 1000)
  };
}

module.exports = { decodeInverterClock };
