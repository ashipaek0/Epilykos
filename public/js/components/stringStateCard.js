const EMPTY = '— / No state configured';
const COLORS = { yellow:'var(--color-warning)', blue:'var(--sky-500)', green:'var(--color-success)', orange:'var(--color-warning)', purple:'var(--olive-600, var(--accent))', 'light-blue':'var(--sky-500)', grey:'var(--text-secondary)' };
function colorToken(color) { return COLORS[String(color || '').toLowerCase()] || 'var(--text)'; }
function paint(container, valueEl, entry, cfg) {
  const raw = entry && entry.value;
  const valid = (typeof raw === 'string' || typeof raw === 'boolean') && String(raw).trim() !== '';
  const key = valid ? String(raw).trim().toLowerCase() : null;
  const mapping = key === null ? null : (cfg.mappings || []).find(item => item && typeof item.value === 'string' && item.value.trim().toLowerCase() === key);
  if (!mapping) { valueEl.textContent = cfg.metric ? EMPTY : 'Configure a metric'; valueEl.style.color = 'var(--text-secondary)'; container.style.backgroundColor = ''; container.style.color = ''; container.dataset.stateStatus = 'no-data'; return; }
  valueEl.textContent = String(mapping.label ?? '');
  const color = colorToken(mapping.color);
  if (cfg.colorMode === 'background') { container.style.backgroundColor = color; container.style.color = 'var(--color-text-on-accent, var(--text))'; valueEl.style.color = 'inherit'; }
  else { container.style.backgroundColor = ''; container.style.color = ''; valueEl.style.color = color; }
  container.dataset.stateStatus = 'data';
}
export function buildStringStateCard(block = {}) {
  const cfg = block.config || {};
  const metric = cfg.binding?.metric || cfg.metric || '';
  const config = { metric, mappings: Array.isArray(cfg.mappings) ? cfg.mappings : [], colorMode: cfg.colorMode === 'background' ? 'background' : 'value' };
  const container = document.createElement('div'); container.className = 'string-state-card stat-card'; container.dataset.blockId = block.id || ''; container.dataset.metricMap = JSON.stringify(config); container.style.cssText = 'min-width:0;max-width:100%;box-sizing:border-box;overflow:hidden;height:100%;';
  const label = document.createElement('div'); label.className = 'stat-label string-state-label'; label.textContent = cfg.label || metric; container.appendChild(label);
  const value = document.createElement('div'); value.className = 'stat-value string-state-value'; value.style.cssText = 'overflow-wrap:anywhere;word-break:break-word;white-space:normal;max-width:100%;'; container.appendChild(value);
  paint(container, value, null, config); return container;
}
export function updateStringStateCard(state) {
  const metrics = state && state.metrics || {};
  document.querySelectorAll('.string-state-card').forEach(container => { let cfg = {}; try { cfg = JSON.parse(container.dataset.metricMap || '{}'); } catch { cfg = {}; } const value = container.querySelector('.string-state-value'); if (value) paint(container, value, metrics[cfg.metric], cfg); });
}
