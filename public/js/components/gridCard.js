import { renderTimelineBar, formatHoursToHM, updateGridDate, formatTimestamp } from '../grid.js';

export function buildGridCard() {
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.innerHTML = `
    <div class="grid-date" id="grid-date"></div>
    <div class="grid-stats">
      <div class="stat-card">
        <div class="stat-label">Grid Status</div>
        <div class="stat-value" id="grid-state">--</div>
        <div class="stat-sub" id="grid-state-since" style="font-size: 0.75rem; margin-top: 0.25rem;"></div>
      </div>
      <div class="stat-card"><div class="stat-label">Today's Grid</div><div class="stat-value" id="grid-hours-day">--</div></div>
      <div class="stat-card"><div class="stat-label">This Week</div><div class="stat-value" id="grid-hours-week">--</div></div>
      <div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value" id="grid-hours-month">--</div></div>
      <div class="stat-card"><div class="stat-label">This Year</div><div class="stat-value" id="grid-hours-year">--</div></div>
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
    const sinceEl = document.getElementById('grid-state-since');
    if (sinceEl) sinceEl.textContent = '';
    return;
  }

  const currentState = gs.current ? 'ON' : 'OFF';
  document.getElementById('grid-state').textContent = `⚡ ${currentState}`;
  document.getElementById('grid-state').style.color = gs.current ? 'var(--battery)' : 'var(--grid)';

  // Show only the timestamp for the current state
  const sinceEl = document.getElementById('grid-state-since');
  const lastChangeTimestamp = gs.current ? gs.lastOn : gs.lastOff;
  if (sinceEl) {
    if (lastChangeTimestamp) {
      sinceEl.textContent = `since ${formatTimestamp(lastChangeTimestamp)}`;
    } else {
      sinceEl.textContent = '';
    }
  }

  const gh = state.gridHours || {};
  document.getElementById('grid-hours-day').textContent = formatHoursToHM(gh.day || 0);
  document.getElementById('grid-hours-week').textContent = formatHoursToHM(gh.week || 0);
  document.getElementById('grid-hours-month').textContent = formatHoursToHM(gh.month || 0);
  document.getElementById('grid-hours-year').textContent = formatHoursToHM(gh.year || 0);
  updateGridDate();

  if (state.gridTimeline && state.gridTimeline.segments) {
    renderTimelineBar(state.gridTimeline.segments, state.gridTimeline.windowStart, state.gridTimeline.windowEnd);
  }
}
