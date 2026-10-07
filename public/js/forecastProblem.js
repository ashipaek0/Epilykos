/**
 * One sentence for a forecast or weather card that has nothing to show: what
 * is wrong and what to do, instead of the server's internal error text.
 *
 * forecastProblem({ label, error, lastGood }) -> string
 *   label     the source shown on the card ("Auto", "Solcast", "Open-Meteo" ...)
 *   error     the server's error string, if any
 *   lastGood  when the card last had data (a time string), if ever
 *   what      'forecast' (default) or 'weather'
 *
 * @module forecastProblem
 */
const SETTINGS = 'Settings › Forecast and weather';

export function forecastProblem({ label = '', error = '', lastGood = '', what = 'forecast' } = {}) {
  const e = String(error || ''), thing = what === 'weather' ? 'the weather' : 'a forecast';
  let msg;
  if (/location required/i.test(e)) msg = `Set your location in ${SETTINGS} to see ${thing}.`;
  else if (/capacity not configured/i.test(e)) msg = `Set your panels' capacity in ${SETTINGS} to get a forecast.`;
  else if (/forecast disabled/i.test(e)) msg = `The forecast is turned off in ${SETTINGS}.`;
  else if (/solcast/i.test(e)) msg = `Solcast isn't answering. Check the API key and site in ${SETTINGS}; it tries again on its own.`;
  else if (/^source unavailable: rest:/i.test(e)) msg = `The forecast source "${e.replace(/^source unavailable: rest:/i, '')}" isn't set up or is turned off. Pick another in the card's settings.`;
  else if (e) msg = `${label && !/^auto$/i.test(label) ? label : `The ${what} service`} can't be reached right now. It tries again on its own.`;
  else msg = `No ${what} yet.`;
  return lastGood ? `${msg} Last ${what} at ${lastGood}.` : msg;
}
