/**
 * Grid Card — displays grid ON/OFF status, cumulative hours, last change timestamp,
 * and a 24h timeline bar of state changes.
 */
import { renderTimelineBar, formatHoursToHM, updateGridDate, formatTimestamp } from '../grid.js';
import { uid } from '../utils/uid.js';

export function buildGridCard(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const showTimeline = config.showTimeline !== false;
  const metrics = config.metrics || {};
  const gridStatusMetric = metrics.grid_status || '';

  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.metricMap = JSON.stringify({ grid_status: gridStatusMetric });
  card.dataset.blockId = id;

  card.innerHTML = `
    <div class="grid-date" id="${uid('grid-date', id)}"></div>
    <div class="grid-stats">
      <div class="stat-card">
        <div class="stat-label">Grid Status</div>
        <div class="stat-value" id="${uid('grid-state', id)}">--</div>
        <div class="stat-sub" id="${uid('grid-state-since', id)}"></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Today</div>
        <div class="stat-value" id="${uid('grid-hours-day', id)}">--</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">This Week</div>
        <div class="stat-value" id="${uid('grid-hours-week', id)}">--</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">This Month</div>
        <div class="stat-value" id="${uid('grid-hours-month', id)}">--</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">This Year</div>
        <div class="stat-value" id="${uid('grid-hours-year', id)}">--</div>
      </div>
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
      current = (state.metrics[gsm]?.value) > 0;
      lastChange = current ? gs.lastOn : gs.lastOff;
    } else if (gs.configured) {
      current = gs.current;
      lastChange = gs.lastChange?.time || (current ? gs.lastOn : gs.lastOff);
    }

    // Status display
    const se = document.getElementById(uid('grid-state', id));
    if (se) {
      if (current === null) {
        se.textContent = 'No data';
        se.style.color = 'var(--text-secondary)';
      } else {
        se.textContent = current ? 'ON' : 'OFF';
        se.style.color = current ? 'var(--grid)' : 'var(--battery)';
      }
    }
    const si = document.getElementById(uid('grid-state-since', id));
    if (si) {
      si.textContent = lastChange ? `since ${formatTimestamp(lastChange)}` : '';
    }

    // Hours
    const hoursDayEl = document.getElementById(uid('grid-hours-day', id));
    if (hoursDayEl) hoursDayEl.textContent = formatHoursToHM(gh.day || 0);
    const hoursWeekEl = document.getElementById(uid('grid-hours-week', id));
    if (hoursWeekEl) hoursWeekEl.textContent = formatHoursToHM(gh.week || 0);
    const hoursMonthEl = document.getElementById(uid('grid-hours-month', id));
    if (hoursMonthEl) hoursMonthEl.textContent = formatHoursToHM(gh.month || 0);
    const hoursYearEl = document.getElementById(uid('grid-hours-year', id));
    if (hoursYearEl) hoursYearEl.textContent = formatHoursToHM(gh.year || 0);

    // Date
    updateGridDate(id);

    // Timeline
    const te = document.getElementById(uid('grid-timeline', id));
    if (te && gt.segments?.length) {
      renderTimelineBar(gt.segments, gt.windowStart, gt.windowEnd, id);
    }
  });
}
