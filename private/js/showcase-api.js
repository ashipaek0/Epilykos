/**
 * Showcase API: answers the cards' /api requests in the browser from the
 * made-up home in showcase-data.js. Installed before any card loads, so on
 * this page no card request reaches the server: not to read your data, and
 * not to switch anything (the switch and selector change only this page).
 *
 * @module showcase-api
 */
import * as data from './showcase-data.js';

const realFetch = window.fetch.bind(window);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const wait = ms => new Promise(r => setTimeout(r, ms));
const today = () => data.dayKey(Date.now());

/** GET handlers by path. */
const GET = {
  '/api/dashboard-state': () => data.dashboardState(),
  '/api/public-config': () => data.publicConfig,
  '/api/auth/status': () => ({ authenticated: true }),
  '/api/network-config': () => ({ localURL: '', remoteURL: '' }),
  '/api/metrics/history': q => data.metricHistory(q.get('metric') || '', Math.min(168, Math.max(1, parseInt(q.get('hours'), 10) || 24))),
  '/api/history': q => data.powerRows(Math.min(7, Math.max(1, parseInt(q.get('days'), 10) || 1))),
  '/api/history/power-stats': q => data.powerStats(Number(q.get('from')), Number(q.get('to')), (q.get('fields') || '').split(',').filter(Boolean)),
  '/api/energy/hourly': q => {
    const date = q.get('date') || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: { code: 'invalid_request', message: 'date must be YYYY-MM-DD' } }, 400);
    return data.energyHourly(date, q.get('forecast') === '1');
  },
  '/api/daily': q => data.dailyRows(Math.min(30, Math.max(1, parseInt(q.get('days'), 10) || 7))),
  '/api/monthly': () => data.monthlyRows(),
  '/api/solar-forecast': () => data.solarForecast(),
  '/api/solar/intraday': () => data.solarIntraday()
};

/** The showcase switch and selector: change the page's own state, after a short pause like a real device. */
async function action(init) {
  let body = {};
  try { body = JSON.parse(init && init.body || '{}'); } catch { /* empty body */ }
  await wait(450);
  const entity = body.entity;
  if (!(entity in data.controls)) return json({ success: false, error: 'Not part of the showcase' }, 404);
  if (entity.startsWith('switch.')) data.controls[entity] = data.controls[entity] === 'on' ? 'off' : 'on';
  else if (body.params && body.params.value != null) data.controls[entity] = String(body.params.value);
  return json({ success: true });
}

async function showcaseFetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  const method = String((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  if (method === 'POST' && url.pathname === '/api/action') return action(init);
  const handler = method === 'GET' ? GET[url.pathname] : null;
  if (!handler) return json({ error: 'Not part of the showcase' }, 404);
  await wait(60);
  const out = handler(url.searchParams);
  return out instanceof Response ? out : json(out);
}

window.fetch = showcaseFetch;
