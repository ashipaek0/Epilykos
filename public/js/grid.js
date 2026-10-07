export function formatHoursToHM(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h.toString().padStart(2, '0')}h:${m.toString().padStart(2, '0')}m`;
}

export function formatTimestamp(ts) {
  if (!ts) return 'never';
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

export function updateGridDate(id) {
  const dateEl = document.getElementById(id ? `grid-date-${id}` : 'grid-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  }
}

export function renderTimelineBar(segments, windowStart, windowEnd, id) {
  const container = document.getElementById(id ? `grid-timeline-${id}` : 'grid-timeline');
  if (!container) return;
  container.innerHTML = '';
  if (!segments.length) return;
  const totalMs = windowEnd - windowStart;
  if (totalMs <= 0) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'tl-tooltip';
  tooltip.style.display = 'none';
  container.appendChild(tooltip);

  const bar = document.createElement('div');
  bar.className = 'tl-bar';

  segments.forEach(seg => {
    const segStart = Math.max(seg.start, windowStart);
    const segEnd = Math.min(seg.end, windowEnd);
    if (segEnd <= segStart) return;
    const duration = segEnd - segStart;
    const pct = (duration / totalMs) * 100;

    const el = document.createElement('div');
    el.className = 'tl-segment' + (seg.state === 1 ? ' on' : ' off');
    el.style.flexGrow = duration;
    el.style.flexBasis = '0px';
    if (pct >= 4) el.textContent = seg.state === 1 ? 'ON' : 'OFF';

    // Details on hover, keyboard focus and tap (not mouse-only), read out too.
    const span = Math.round(duration / 60000), dur = span >= 60 ? `${Math.floor(span / 60)} h${span % 60 ? ` ${span % 60} min` : ''}` : `${span} min`;
    const text = `Grid ${seg.state === 1 ? 'on' : 'off'} from ${new Date(seg.start).toLocaleString()} until ${segEnd < windowEnd ? new Date(segEnd).toLocaleString() : 'now'}, ${dur}`;
    el.tabIndex = 0;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', text);
    const show = () => {
      tooltip.style.display = 'block';
      tooltip.textContent = text;
      const barRect = bar.getBoundingClientRect(), elRect = el.getBoundingClientRect(), half = tooltip.offsetWidth / 2;
      // Centred on the period, but kept inside the bar at either end.
      const x = Math.max(half, Math.min(barRect.width - half, elRect.left - barRect.left + elRect.width / 2));
      tooltip.style.left = x + 'px';
      tooltip.style.top = (-tooltip.offsetHeight - 8) + 'px';
      if (tooltip._for !== el) tooltip._shownAt = Date.now();
      tooltip._for = el;
    };
    const hide = () => { if (tooltip._for === el) { tooltip.style.display = 'none'; tooltip._for = null; } };
    // Hover is for a mouse only: a tap also sends compatibility mouse events,
    // including a leave right after the click, which would close it at once.
    el.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') show(); });
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
    el.addEventListener('focus', show);
    el.addEventListener('blur', hide);
    // A tap focuses (which opens) then clicks: only a later tap closes.
    el.addEventListener('click', () => { if (tooltip._for === el && tooltip.style.display === 'block' && Date.now() - tooltip._shownAt > 400) hide(); else show(); });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') hide();
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
    });
    bar.appendChild(el);
  });
  container.appendChild(bar);

  const labelRow = document.createElement('div');
  labelRow.className = 'tl-labels';
  const tickInterval = 4 * 60 * 60 * 1000;
  const firstTick = Math.ceil(windowStart / 3600000) * 3600000;
  for (let t = firstTick; t <= windowEnd; t += tickInterval) {
    const pct = ((t - windowStart) / totalMs) * 100;
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = pct + '%';
    // Labels near the ends line up with the edge instead of hanging over it.
    if (pct < 6) { tick.style.transform = 'none'; tick.style.alignItems = 'flex-start'; }
    else if (pct > 94) { tick.style.transform = 'translateX(-100%)'; tick.style.alignItems = 'flex-end'; }
    const d = new Date(t);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'tl-time';
    timeSpan.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    tick.appendChild(timeSpan);
    if (d.getHours() === 0) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'tl-date';
      dateSpan.textContent = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
      tick.appendChild(dateSpan);
    }
    labelRow.appendChild(tick);
  }
  container.appendChild(labelRow);
}
