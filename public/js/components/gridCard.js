import { renderTimelineBar, formatHoursToHM, updateGridDate, formatTimestamp } from '../grid.js';

export function buildGridCard() {
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.innerHTML = `
    <div class="grid-date" id="grid-date"></div>
    <div class="grid-stats">
      <div class="stat-card"><div class="stat-label">Grid Status</div><div class="stat-value" id="grid-state">--</div></div>
      <div class="stat-card"><div class="stat-label">Today's Grid</div><div class="stat-value" id="grid-hours-day">--</div></div>
      <div class="stat-card"><div class="stat-label">This Week</div><div class="stat-value" id="grid-hours-week">--</div></div>
      <div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value" id="grid-hours-month">--</div></div>
      <div class="stat-card"><div class="stat-label">This Year</div><div class="stat-value" id="grid-hours-year">--</div></div>
    </div>
    <div class="grid-last-changes" style="display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: var(--fs-small);">
      <span id="grid-last-on">ON since: --</span>
      <span id="grid-last-off">OFF since: --</span>
    </div>
    <div id="grid-timeline"></div>
  `;
  return card;
}

export function updateGridCardFromState(state) {
  if (!state || !state.gridStatus) return;
  const gs = state.gridStatus;
  if (!gs.configured) {
    document.getElementById('grid-state').textContent = 'Not configured';
    document.getElementById('grid-last-on').textContent = 'ON since: --';
    document.getElementById('grid-last-off').textContent = 'OFF since: --';
    return;
  }
  document.getElementById('grid-state').textContent = gs.current ? '⚡ ON' : '⚫ OFF';
  document.getElementById('grid-state').style.color = gs.current ? 'var(--battery)' : 'var(--grid)';
  const gh = state.gridHours || {};
  document.getElementById('grid-hours-day').textContent = formatHoursToHM(gh.day || 0);
  document.getElementById('grid-hours-week').textContent = formatHoursToHM(gh.week || 0);
  document.getElementById('grid-hours-month').textContent = formatHoursToHM(gh.month || 0);
  document.getElementById('grid-hours-year').textContent = formatHoursToHM(gh.year || 0);
  updateGridDate();
  if (state.gridTimeline && state.gridTimeline.segments) {
    renderTimelineBar(state.gridTimeline.segments, state.gridTimeline.windowStart, state.gridTimeline.windowEnd);
  }

  // Update last change timestamps
  const lastOnSpan = document.getElementById('grid-last-on');
  const lastOffSpan = document.getElementById('grid-last-off');
  if (lastOnSpan && lastOffSpan) {
    lastOnSpan.textContent = gs.lastOn ? `ON since ${formatTimestamp(gs.lastOn)}` : 'ON since --';
    lastOffSpan.textContent = gs.lastOff ? `OFF since ${formatTimestamp(gs.lastOff)}` : 'OFF since --';
  }
}
