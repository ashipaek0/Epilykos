/**
 * Grid Card — displays grid ON/OFF status, cumulative hours, last change timestamp,
 * and a 24h timeline bar of state changes.
 */
import { renderTimelineBar, updateGridDate, formatTimestamp } from '../grid.js';
import { formatDuration } from './format.js';
import { uid } from '../utils/uid.js';

export function buildGridCard(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const showTimeline = config.showTimeline !== false;
  const metrics = config.metrics || {};
  const gridStatusMetric = metrics.grid_status || '';

  const card = document.createElement('div');
  card.className = 'grid-card ep-card';
  card.dataset.metricMap = JSON.stringify({ grid_status: gridStatusMetric });
  card.dataset.blockId = id;

  card.innerHTML = `
    <div class="ep-grid-head">
      <h3 class="ep-card-title">Grid</h3>
      <div class="grid-date" id="${uid('grid-date', id)}"></div>
    </div>
    <div class="ep-grid-now">
      <span class="ep-grid-state" id="${uid('grid-state', id)}">—</span>
      <span class="ep-grid-since stat-sub" id="${uid('grid-state-since', id)}"></span>
    </div>
    <div class="ep-grid-hours-title ep-label">Time on grid</div>
    <div class="grid-stats ep-tiles ep-tiles-compact">
      <div class="stat-card ep-tile"><div class="stat-label ep-label">Today</div><div class="stat-value ep-value" id="${uid('grid-hours-day', id)}">—</div></div>
      <div class="stat-card ep-tile"><div class="stat-label ep-label">Week</div><div class="stat-value ep-value" id="${uid('grid-hours-week', id)}">—</div></div>
      <div class="stat-card ep-tile"><div class="stat-label ep-label">Month</div><div class="stat-value ep-value" id="${uid('grid-hours-month', id)}">—</div></div>
      <div class="stat-card ep-tile"><div class="stat-label ep-label">Year</div><div class="stat-value ep-value" id="${uid('grid-hours-year', id)}">—</div></div>
    </div>
    ${showTimeline ? `<div id="${uid('grid-timeline', id)}"></div>` : ''}
  `;
  return card;
}

export function updateGridCardFromState(state) {
  if (!state) return;
  const gs = state.gridStatus || {};
  const gh = state.gridHours || {};
  const gt = state.gridTimeline || {};

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

    // Hours
    const hoursDayEl = document.getElementById(uid('grid-hours-day', id));
    if (hoursDayEl) {
      if (gh.configured === false) hoursDayEl.textContent = 'Not configured';
      else if (gh.available === false) hoursDayEl.textContent = 'No data';
      else hoursDayEl.textContent = formatDuration(gh.day || 0);
    }
    const hoursWeekEl = document.getElementById(uid('grid-hours-week', id));
    if (hoursWeekEl) {
      if (gh.configured === false) hoursWeekEl.textContent = 'Not configured';
      else if (gh.available === false) hoursWeekEl.textContent = 'No data';
      else hoursWeekEl.textContent = formatDuration(gh.week || 0);
    }
    const hoursMonthEl = document.getElementById(uid('grid-hours-month', id));
    if (hoursMonthEl) {
      if (gh.configured === false) hoursMonthEl.textContent = 'Not configured';
      else if (gh.available === false) hoursMonthEl.textContent = 'No data';
      else hoursMonthEl.textContent = formatDuration(gh.month || 0);
    }
    const hoursYearEl = document.getElementById(uid('grid-hours-year', id));
    if (hoursYearEl) {
      if (gh.configured === false) hoursYearEl.textContent = 'Not configured';
      else if (gh.available === false) hoursYearEl.textContent = 'No data';
      else hoursYearEl.textContent = formatDuration(gh.year || 0);
    }

    // Date
    updateGridDate(id);

    // Timeline
    const te = document.getElementById(uid('grid-timeline', id));
    if (te && gt.segments?.length) {
      renderTimelineBar(gt.segments, gt.windowStart, gt.windowEnd, id);
    }
  });
}
