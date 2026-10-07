/**
 * System overview card: the installation at a glance.
 *
 *   header   Last updated · Status · Local time
 *   left     Grid, Battery           centre   inverter hub with its state
 *   right    Solar, Home             side     up to 3 extra metric tiles
 *
 * Each main tile shows the live value, today's energy in its corner and a
 * 24-hour sparkline behind it (from the dashboard's power history). Lines from
 * the tiles to the hub animate in the direction power is flowing.
 *
 * Updated by cards-update.js with each dashboard state.
 *
 * @module components/systemOverview
 */
import { escapeHtml } from '../utils.js';
import { formatMetric, formatEntry } from './format.js';
import { icon } from '../editor-catalog.js';
import { getSharedForecastData } from '../forecast.js';
import { iconHtml } from '../weatherFormat.js';

const FLOW_MIN_W = 20;          // below this a line is drawn idle
const STALE_MS = 5 * 60 * 1000; // data older than this marks the status as delayed
const TILES = {
  grid: { label: 'Grid', color: '--color-grid', icon: 'plug', side: 'left' },
  battery: { label: 'Battery', color: '--color-battery', icon: 'chartArea', side: 'left' },
  solar: { label: 'Solar', color: '--color-solar', icon: 'sun', side: 'right' },
  home: { label: 'Home', color: '--color-home', icon: 'flow', side: 'right' },
  // PV split: AC-coupled PV inverters and DC solar chargers (MPPTs), when both are set.
  pvi: { label: 'PV inverter', color: '--color-solar', icon: 'sun', side: 'right' },
  pvc: { label: 'PV charger', color: '--color-solar', icon: 'sun', side: 'right' }
};
const HISTORY_MS = 5 * 60 * 1000, WEATHER_MS = 15 * 60 * 1000;
const state = { history: null };   // last power history seen (deltas don't repeat it)

const watts = kw => (Number.isFinite(kw) ? kw * 1000 : null);
const kwhText = v => (Number.isFinite(v) ? `${v >= 100 ? Math.round(v) : v.toFixed(1)} kWh` : '');

function tileHtml(key) {
  const t = TILES[key];
  return `<section class="so-tile so-${key}" data-tile="${key}" style="--so-c: var(${t.color})">
    <svg class="so-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path class="so-spark-area"/><path class="so-spark-line"/></svg>
    <header><h4><span class="so-icon" aria-hidden="true">${icon(t.icon, 16)}</span><span class="so-name">${t.label}</span></h4><span class="so-corner"></span></header>
    <p class="so-value"><span class="so-num">—</span> <span class="so-unit"></span></p>
  </section>`;
}

export function buildSystemOverview(block = {}) {
  const config = block.config || {};
  const extras = (Array.isArray(config.extras) ? config.extras : []).filter(e => e && e.metric).slice(0, 3);
  const pv = config.pv || {}, split = !!(pv.inverter && pv.charger);
  const weather = config.showWeather === true;
  const side = split || weather || extras.length;
  const card = document.createElement('div');
  card.className = 'system-overview-card';
  card.dataset.blockId = block.id || '';
  card.dataset.extras = JSON.stringify(extras);
  if (split) card.dataset.pv = JSON.stringify({ inverter: pv.inverter, charger: pv.charger });
  const image = typeof config.inverter_image === 'string' && /^(https?:\/\/|\/)/i.test(config.inverter_image) ? config.inverter_image : '';
  const hub = image
    ? `<img src="${escapeHtml(image)}" alt="" class="so-hub-img">`
    : `<span class="so-hub-icon" aria-hidden="true">${icon('topology', 30)}</span>`;
  card.innerHTML = `
    <div class="so-head">
      ${config.title ? `<h3 class="so-title">${escapeHtml(config.title)}</h3>` : '<span></span>'}
      <dl class="so-strip">
        <div><dt>Last updated</dt><dd class="so-updated">—</dd></div>
        <div><dt>Status</dt><dd class="so-status">—</dd></div>
        <div><dt>Local time</dt><dd class="so-time">—</dd></div>
        <div class="so-strip-inverter"><dt>Inverter</dt><dd class="so-inverter">—</dd></div>
      </dl>
    </div>
    <div class="so-body${side ? ' has-extras' : ''}${split ? ' is-split' : ''}">
      <div class="so-diagram">
        <svg class="so-lines" aria-hidden="true"></svg>
        <div class="so-col so-left">${tileHtml('grid')}${tileHtml('battery')}</div>
        <div class="so-hub"><div class="so-hub-box">${hub}<span class="so-hub-state">—</span></div></div>
        <div class="so-col so-right">${split ? tileHtml('pvi') + tileHtml('home') + tileHtml('pvc') : tileHtml('solar') + tileHtml('home')}</div>
      </div>
      ${side ? `<div class="so-extras">${split ? tileHtml('solar').replace('<span class="so-name">Solar</span>', '<span class="so-name">Total solar</span>') : ''}${weather ? `<section class="so-tile so-weather" data-tile="weather"><header><h4><span class="so-name">Weather</span></h4><span class="so-corner so-wx-desc"></span></header><p class="so-value"><span class="so-num">—</span> <span class="so-unit"></span><span class="so-wx-icon"></span></p></section>` : ''}${extras.map((e, i) => `<section class="so-tile so-extra" data-extra="${i}"><header><h4><span class="so-name">${escapeHtml(e.label || e.metric)}</span></h4></header><p class="so-value"><span class="so-num">—</span> <span class="so-unit"></span></p></section>`).join('')}</div>` : ''}
    </div>`;
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (!card.isConnected) ro.disconnect(); else drawLines(card); }) : null;
  requestAnimationFrame(() => { ro?.observe(card); drawLines(card); });
  const clock = setInterval(() => { if (!card.isConnected) clearInterval(clock); else tick(card); }, 15000);
  tick(card);
  if (split) { loadPvHistory(card); const t = setInterval(() => { if (!card.isConnected) clearInterval(t); else loadPvHistory(card); }, HISTORY_MS); }
  if (weather) { loadWeather(card); const t = setInterval(() => { if (!card.isConnected) clearInterval(t); else loadWeather(card); }, WEATHER_MS); }
  return card;
}

/** 24-hour sparklines for the PV split tiles (their metrics are not in the power history). */
async function loadPvHistory(card) {
  let pv; try { pv = JSON.parse(card.dataset.pv || 'null'); } catch (_) { pv = null; }
  if (!pv) return;
  for (const [key, metric] of [['pvi', pv.inverter], ['pvc', pv.charger]]) {
    try {
      const res = await fetch(`/api/metrics/history?metric=${encodeURIComponent(metric)}&hours=24`, { credentials: 'same-origin' });
      if (!res.ok) continue;
      const rows = await res.json();
      if (Array.isArray(rows)) spark(card, key, rows.map(r => Number(r.value)));
    } catch (_) { /* keep the last sparkline */ }
  }
}

/** Weather tile: temperature, conditions and icon from the forecast source. */
async function loadWeather(card) {
  const tile = card.querySelector('.so-weather'); if (!tile) return;
  try {
    const data = await getSharedForecastData('auto', {});
    const w = data && data.weather;
    if (!w || w.available === false || w.temp == null) { tile.querySelector('.so-num').textContent = '—'; tile.querySelector('.so-wx-desc').textContent = 'Unavailable'; return; }
    tile.querySelector('.so-num').textContent = String(Math.round(Number(w.temp)));
    tile.querySelector('.so-unit').textContent = '°C';
    tile.querySelector('.so-wx-desc').textContent = w.desc || '';
    tile.querySelector('.so-wx-icon').innerHTML = iconHtml(w.icon_class, w.code, w.is_day !== 0);
  } catch (_) { tile.querySelector('.so-wx-desc').textContent = 'Unavailable'; }
}

/** Orthogonal lines from each tile's inner edge to the hub. */
function drawLines(card) {
  const svg = card.querySelector('.so-lines'), diagram = card.querySelector('.so-diagram'), hub = card.querySelector('.so-hub-box');
  if (!svg || !hub || !diagram.offsetWidth) return;
  const box = diagram.getBoundingClientRect(), h = hub.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const hubY = h.top - box.top + h.height / 2;
  svg.innerHTML = Object.keys(TILES).filter(key => card.querySelector(`.so-diagram .so-tile[data-tile="${key}"]`)).map(key => {
    const tile = card.querySelector(`.so-diagram .so-tile[data-tile="${key}"]`).getBoundingClientRect();
    const left = TILES[key].side === 'left';
    const x1 = (left ? tile.right : tile.left) - box.left, y1 = tile.top - box.top + tile.height / 2;
    const x2 = (left ? h.left : h.right) - box.left, mid = (x1 + x2) / 2;
    const y2 = hubY + ({ grid: -10, solar: -10, pvi: -14, home: 0, pvc: 14 }[key] ?? 10);
    return `<path class="so-line" data-line="${key}" d="M${x1},${y1} H${mid} V${y2} H${x2}"/>`;
  }).join('');
  const last = card._soLast; if (last) applyFlows(card, last);
}

function tick(card) {
  const ts = card._soTimestamp;
  const now = new Date();
  card.querySelector('.so-time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!ts) return;
  const age = now.getTime() - ts;
  card.querySelector('.so-updated').textContent = age < 60000 ? 'Just now' : age < 3600000 ? `${Math.round(age / 60000)} min ago` : new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  const status = card.querySelector('.so-status');
  status.textContent = age > STALE_MS ? 'Data delayed' : 'Online';
  status.dataset.state = age > STALE_MS ? 'warn' : 'ok';
}

function spark(card, key, values) {
  const svg = card.querySelector(`.so-tile[data-tile="${key}"] .so-spark`);
  if (!svg) return;
  const pts = values.filter(v => Number.isFinite(v));
  if (pts.length < 2) { svg.querySelector('.so-spark-line').setAttribute('d', ''); svg.querySelector('.so-spark-area').setAttribute('d', ''); return; }
  const min = Math.min(0, ...pts), max = Math.max(...pts, min + 1e-6);
  const xy = values.map((v, i) => [i / (values.length - 1) * 100, Number.isFinite(v) ? 30 - ((v - min) / (max - min)) * 26 - 2 : null]).filter(p => p[1] != null);
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
  const zero = 30 - ((0 - min) / (max - min)) * 26 - 2;
  svg.querySelector('.so-spark-line').setAttribute('d', line);
  svg.querySelector('.so-spark-area').setAttribute('d', `${line}L${xy[xy.length - 1][0]},${zero}L${xy[0][0]},${zero}Z`);
}

/** Live values -> each line's direction: 'in' (towards the hub), 'out' or idle. */
function applyFlows(card, c) {
  const set = (key, w, towardsHub) => {
    const line = card.querySelector(`.so-line[data-line="${key}"]`); if (!line) return;
    const on = Number.isFinite(w) && Math.abs(w) >= FLOW_MIN_W;
    line.dataset.flow = !on ? 'idle' : (towardsHub ? 'in' : 'out');
    line.style.setProperty('--so-c', `var(${TILES[key].color})`);
  };
  const gridW = watts((c.grid_import_kw || 0) - (c.grid_export_kw || 0));
  const battW = watts(c.battery_power_kw);
  set('grid', gridW, gridW > 0);
  set('battery', battW, battW < 0);          // discharging flows towards the hub
  set('solar', watts(c.solar_kw), true);
  set('pvi', card._soPv?.inverter, true);
  set('pvc', card._soPv?.charger, true);
  set('home', watts(c.consumption_kw), false);
}

function setValue(tile, formatted) {
  tile.querySelector('.so-num').textContent = formatted.value;
  tile.querySelector('.so-unit').textContent = formatted.unit;
}

export function updateSystemOverview(dashboardState) {
  const c = dashboardState?.current;
  if (Array.isArray(dashboardState?.powerHistory) && dashboardState.powerHistory.length) state.history = dashboardState.powerHistory;
  document.querySelectorAll('.system-overview-card').forEach(card => {
    if (c) {
      card._soLast = c;
      card._soTimestamp = c.timestamp || card._soTimestamp;
      const tile = k => card.querySelector(`.so-tile[data-tile="${k}"]`);
      // Grid: net import (+) / export (-), or Off when grid status says so.
      const gs = dashboardState.gridStatus || {};
      const gridW = watts((c.grid_import_kw || 0) - (c.grid_export_kw || 0));
      if (gs.configured && gs.available && gs.current === false) { setValue(tile('grid'), { value: 'Off', unit: '' }); }
      else setValue(tile('grid'), formatMetric(gridW, 'W'));
      tile('grid').querySelector('.so-name').textContent = gridW < -FLOW_MIN_W ? 'Grid (export)' : 'Grid';
      tile('grid').querySelector('.so-corner').textContent = kwhText(c.daily_grid_import_kwh);
      // Battery: charge % big, power in the corner, state as the name.
      const battW = watts(c.battery_power_kw);
      setValue(tile('battery'), formatMetric(c.battery_soc, '%'));
      tile('battery').querySelector('.so-name').textContent = !Number.isFinite(battW) || Math.abs(battW) < FLOW_MIN_W ? 'Battery' : battW > 0 ? 'Charging' : 'Discharging';
      tile('battery').querySelector('.so-corner').textContent = Number.isFinite(battW) ? formatMetric(battW, 'W').text : '';
      setValue(tile('solar'), formatMetric(watts(c.solar_kw), 'W'));
      let pv = null; try { pv = JSON.parse(card.dataset.pv || 'null'); } catch (_) { /* no split */ }
      if (pv) {
        const read = m => { const e = dashboardState?.metrics?.[m]; const n = Number(e?.value); return Number.isFinite(n) ? n * (String(e?.unit || '').toLowerCase() === 'kw' ? 1000 : 1) : null; };
        card._soPv = { inverter: read(pv.inverter), charger: read(pv.charger) };
        setValue(tile('pvi'), formatMetric(card._soPv.inverter, 'W'));
        setValue(tile('pvc'), formatMetric(card._soPv.charger, 'W'));
      }
      tile('solar').querySelector('.so-corner').textContent = kwhText(c.daily_solar_kwh);
      setValue(tile('home'), formatMetric(watts(c.consumption_kw), 'W'));
      tile('home').querySelector('.so-corner').textContent = kwhText(c.daily_consumption_kwh);
      // Hub state: what the inverter is doing right now.
      const solarW = watts(c.solar_kw) || 0;
      const hubState = gridW > FLOW_MIN_W && battW > FLOW_MIN_W ? 'Charging from grid'
        : battW > FLOW_MIN_W ? 'Charging' : battW < -FLOW_MIN_W ? 'Inverting'
        : gridW > FLOW_MIN_W ? 'Passthrough' : solarW > FLOW_MIN_W ? 'Solar' : 'Idle';
      card.querySelector('.so-hub-state').textContent = hubState;
      card.querySelector('.so-inverter').textContent = hubState;   // shown in the strip on narrow cards, where the hub is hidden
      applyFlows(card, c);
      tick(card);
    }
    if (state.history) {
      const h = state.history;
      spark(card, 'grid', h.map(p => (p.grid_import_kw || 0) - (p.grid_export_kw || 0)));
      spark(card, 'battery', h.map(p => (Number.isFinite(p.battery_soc) ? p.battery_soc : null)));
      spark(card, 'solar', h.map(p => p.solar_kw));
      spark(card, 'home', h.map(p => p.consumption_kw));
    }
    let extras = []; try { extras = JSON.parse(card.dataset.extras || '[]'); } catch (_) {}
    extras.forEach((e, i) => {
      const t = card.querySelector(`.so-extra[data-extra="${i}"]`); if (!t) return;
      setValue(t, formatEntry(dashboardState?.metrics?.[e.metric], e.unit, e.metric));
    });
  });
}
