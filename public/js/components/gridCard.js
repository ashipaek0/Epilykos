/**
 * Grid Card — displays grid ON/OFF status, cumulative hours, last change timestamp,
 * and a 24h timeline bar of state changes. Optional, per card:
 *   periods         which "time on grid" tiles to show (today, week, month, year, all time)
 *   showCost        the cost of the grid energy bought, under each tile
 *   showDailyHours  bars of grid hours per day for the last 7, 14 or 30 days
 */
import { renderTimelineBar, updateGridDate, formatTimestamp } from '../grid.js';
import { formatDuration, formatMoney, formatMoneyShort } from './format.js';
import { uid } from '../utils/uid.js';

export const GRID_PERIODS = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All time' },
];
export const DEFAULT_GRID_PERIODS = ['day', 'week', 'month', 'year'];
export const GRID_DAY_RANGES = [7, 14, 30];

/** The tiles a card shows, in a fixed order; older cards have none set and keep the four they had. */
export function gridPeriods(config = {}) {
  const chosen = Array.isArray(config.periods) ? config.periods : DEFAULT_GRID_PERIODS;
  return GRID_PERIODS.filter(p => chosen.includes(p.key));
}

let lastState = null;

export function buildGridCard(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const showTimeline = config.showTimeline !== false;
  const showCost = config.showCost === true;
  const showDays = config.showDailyHours === true;
  const range = GRID_DAY_RANGES.includes(Number(config.dailyRange)) ? Number(config.dailyRange) : 7;
  const periods = gridPeriods(config);
  const metrics = config.metrics || {};
  const gridStatusMetric = metrics.grid_status || '';

  const card = document.createElement('div');
  card.className = 'grid-card ep-card';
  card.dataset.metricMap = JSON.stringify({ grid_status: gridStatusMetric });
  card.dataset.blockId = id;
  card.dataset.daysShown = String(range);

  const tile = p => `<div class="stat-card ep-tile"><div class="stat-label ep-label">${p.label}</div>`
    + `<div class="stat-value ep-value" id="${uid('grid-hours-' + p.key, id)}">—</div>`
    + (showCost ? `<span class="ep-grid-cost" id="${uid('grid-cost-' + p.key, id)}"></span>` : '') + '</div>';

  card.innerHTML = `
    <div class="ep-grid-head">
      <h3 class="ep-card-title">Grid</h3>
      <div class="grid-date" id="${uid('grid-date', id)}"></div>
    </div>
    <div class="ep-grid-now">
      <span class="ep-grid-state" id="${uid('grid-state', id)}">—</span>
      <span class="ep-grid-since stat-sub" id="${uid('grid-state-since', id)}"></span>
    </div>
    ${periods.length ? `<div class="ep-grid-hours-title ep-label">${showCost ? 'Time on grid / grid energy cost' : 'Time on grid'}</div>
    <div class="grid-stats ep-tiles ep-tiles-compact" data-count="${periods.length}">${periods.map(tile).join('')}</div>` : ''}
    ${showTimeline ? `<div id="${uid('grid-timeline', id)}"></div>` : ''}
    ${showDays ? `<div class="ep-grid-days-head"><span class="ep-label">Grid hours per day</span>
      <span class="ep-grid-range" role="group" aria-label="Days shown">${GRID_DAY_RANGES.map(n => `<button type="button" data-range="${n}" aria-pressed="${n === range}">${n} d</button>`).join('')}</span></div>
    <div class="ep-grid-days" id="${uid('grid-days', id)}" role="group" aria-label="Grid hours per day"></div>
    <div class="ep-grid-days-axis"><span id="${uid('grid-days-from', id)}"></span><span>Today</span></div>
    <div class="ep-grid-days-sum" id="${uid('grid-days-sum', id)}" aria-live="polite"></div>` : ''}
  `;

  if (showDays) {
    const sumEl = () => card.querySelector('.ep-grid-days-sum');
    // Hover, keyboard focus or a tap names the day in the summary line.
    const show = ev => {
      const bar = ev.target.closest('.ep-grid-day'), el = sumEl();
      if (bar && el) el.textContent = bar.dataset.text;
    };
    const reset = ev => {
      const el = sumEl();
      if (el && (!ev.relatedTarget || !ev.relatedTarget.closest?.('.ep-grid-day'))) el.innerHTML = el.dataset.summary || '';
    };
    card.addEventListener('pointerover', show);
    card.addEventListener('focusin', show);
    card.addEventListener('pointerout', reset);
    card.addEventListener('focusout', reset);
    card.addEventListener('click', ev => {
      show(ev);
      const btn = ev.target.closest('button[data-range]');
      if (!btn || !card.contains(btn)) return;
      card.dataset.daysShown = btn.dataset.range;
      card.querySelectorAll('button[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      renderDays(card, lastState);
    });
  }
  return card;
}

/** "21 h 24 min": the bars' wording, where a bare 21:24 could read as a time of day. */
function hoursText(h) {
  const m = Math.round(h * 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

function dayLabel(day, opts) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], opts);
}

/** The last N days as bars of grid hours out of 24, with a summary below them. */
function renderDays(card, state) {
  const id = card.dataset.blockId || '';
  const box = document.getElementById(uid('grid-days', id));
  if (!box) return;
  const sumEl = document.getElementById(uid('grid-days-sum', id));
  const fromEl = document.getElementById(uid('grid-days-from', id));
  const all = state?.gridDaily?.days || [];
  if (!state?.gridDaily?.configured || !all.length) {
    box.innerHTML = '';
    if (fromEl) fromEl.textContent = '';
    if (sumEl) sumEl.textContent = state?.gridDaily?.configured === false ? 'Grid status is not set up.' : 'No data yet.';
    return;
  }
  const days = all.slice(-Number(card.dataset.daysShown || 7));
  box.innerHTML = '<span class="ep-grid-days-y" style="top:0">24 h</span><span class="ep-grid-days-y" style="top:50%">12 h</span>'
    + days.map(d => {
      const known = d.hours != null;
      const text = `${d.today ? 'Today so far' : dayLabel(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}: ${known ? hoursText(d.hours) + ' on grid' : 'no data'}`;
      const cls = 'ep-grid-day' + (d.today ? ' today' : '') + (!known ? ' unknown' : d.hours === 0 ? ' none' : '');
      const height = known ? Math.min(100, d.hours / 24 * 100).toFixed(1) : 0;
      return `<div class="${cls}" style="height:${height}%" tabindex="0" role="img" aria-label="${text}" data-text="${text}"></div>`;
    }).join('');
  if (fromEl) fromEl.textContent = dayLabel(days[0].day, { day: 'numeric', month: 'short' });

  // Whole days only: today is still running.
  const done = days.filter(d => !d.today && d.hours != null);
  const parts = [];
  if (done.length) {
    parts.push(`Average <b>${hoursText(done.reduce((a, d) => a + d.hours, 0) / done.length)}</b> a day`);
    const full = done.filter(d => d.hours >= 24 - 1 / 60).length, none = done.filter(d => d.hours === 0).length;
    if (full) parts.push(`${full} full ${full === 1 ? 'day' : 'days'}`);
    if (none) parts.push(`${none} ${none === 1 ? 'day' : 'days'} with none`);
  } else {
    parts.push('No whole days recorded yet.');
  }
  if (sumEl) {
    sumEl.dataset.summary = parts.join(' · ');
    sumEl.innerHTML = sumEl.dataset.summary;
  }
}

export function updateGridCardFromState(state) {
  if (!state) return;
  lastState = state;
  const gs = state.gridStatus || {};
  const gh = state.gridHours || {};
  const gt = state.gridTimeline || {};
  const gc = state.gridCost || {};

  document.querySelectorAll('.grid-card').forEach(card => {
    const id = card.dataset.blockId || '';
    let mm;
    try { mm = JSON.parse(card.dataset.metricMap); } catch (e) { mm = { grid_status: '' }; }
    const gsm = mm.grid_status;

    // Determine current state
    let current = null, lastChange = null;
    if (gsm && state.metrics?.[gsm] !== undefined) {
      const m = state.metrics[gsm];
      let rawState = m?.value;
      if (rawState === null || rawState === undefined) rawState = m?.value_text;
      const s = String(rawState).toLowerCase().trim();
      current = (s === 'on' || s === 'true' || s === '1' || s === 'open' || s === 'unlocked' || (rawState != null && !isNaN(Number(rawState)) && Number(rawState) > 0));
      if (rawState === null || rawState === undefined || s === '' || s === 'unavailable' || s === 'unknown') current = null;
      lastChange = current ? gs.lastOn : gs.lastOff;
    } else if (gs.configured) {
      current = gs.current;
      lastChange = gs.lastChange?.time || (current ? gs.lastOn : gs.lastOff);
    }

    // Status display
    const se = document.getElementById(uid('grid-state', id));
    if (se) {
      se.textContent = current === null ? 'No data' : current ? 'Grid on' : 'Grid off';
      se.dataset.state = current === null ? 'unknown' : current ? 'on' : 'off';
    }
    const si = document.getElementById(uid('grid-state-since', id));
    if (si) {
      si.textContent = lastChange ? `Since ${formatTimestamp(lastChange)}` : '';
    }

    // Hours, and what the grid energy cost, for each period the card shows
    for (const { key } of GRID_PERIODS) {
      const hoursEl = document.getElementById(uid('grid-hours-' + key, id));
      if (hoursEl) {
        if (gh.configured === false) hoursEl.textContent = 'Not configured';
        else if (gh.available === false) hoursEl.textContent = 'No data';
        else hoursEl.textContent = formatDuration(gh[key] || 0);
      }
      const costEl = document.getElementById(uid('grid-cost-' + key, id));
      if (costEl) {
        const cost = gc.cost?.[key] ?? 0;
        costEl.textContent = gc.available ? formatMoneyShort(cost, gc.currency) : '—';
        costEl.title = gc.available
          ? `${formatMoney(cost, gc.currency)}: ${(gc.kwh?.[key] ?? 0).toFixed(1)} kWh bought at ${formatMoney(gc.price, gc.currency)} per kWh`
          : 'Map a daily grid import metric to see what the grid energy cost';
      }
    }

    // Date
    updateGridDate(id);

    // Timeline
    const te = document.getElementById(uid('grid-timeline', id));
    if (te && gt.segments?.length) {
      renderTimelineBar(gt.segments, gt.windowStart, gt.windowEnd, id);
    }

    renderDays(card, state);
  });
}
