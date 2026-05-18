export function buildSystemTopology(block = {}) {
  const config = block.config || {};
  const metrics = config.metrics || {
    solar: 'solar',
    grid: 'grid_import',
    battery_power: 'battery_charge',
    battery_soc: 'battery_soc',
    consumption: 'consumption'
  };

  const container = document.createElement('div');
  container.className = 'flow-card-2';
  container.dataset.metricMap = JSON.stringify(metrics);

  container.innerHTML = `
    <div class="topo-grid">
      <div class="topo-node topo-solar" id="topo-solar">
        <span class="topo-label">Solar</span>
        <div class="topo-node-circle">
          <i id="topo-icon-solar" class="fi fi-sr-solar-panel"></i>
          <span class="topo-value" data-metric="${escapeHtml(metrics.solar)}">0 W</span>
        </div>
      </div>

      <div class="topo-node topo-grid-node" id="topo-grid-node">
        <div class="topo-node-circle">
          <i id="topo-icon-grid" class="fi fi-sr-bolt"></i>
          <span class="topo-value" data-metric="${escapeHtml(metrics.grid)}">0 W</span>
        </div>
        <span class="topo-label">Grid</span>
      </div>

      <div class="topo-center" id="topo-center">
        <div class="topo-hub">${config.inverter_image ? `<img src="${escapeHtml(config.inverter_image)}" alt="Inverter" class="topo-hub-img">` : 'INV'}</div>
      </div>

      <div class="topo-node topo-home" id="topo-home">
        <div class="topo-node-circle">
          <i id="topo-icon-home" class="fi fi-sr-home"></i>
          <span class="topo-value" data-metric="${escapeHtml(metrics.consumption)}">0 W</span>
        </div>
        <span class="topo-label">Home</span>
      </div>

      <div class="topo-node topo-battery" id="topo-battery">
        <div class="topo-node-circle">
          <i id="topo-icon-battery" class="fi fi-sr-battery-full"></i>
          <span class="topo-value" data-metric="${escapeHtml(metrics.battery_soc)}" id="topo-battery-soc">0%</span>
          <span class="topo-sub" data-metric="${escapeHtml(metrics.battery_power)}" id="topo-battery-power">0 W</span>
        </div>
        <span class="topo-label">Battery</span>
      </div>

      <div class="topo-line topo-line-solar"></div>
      <div class="topo-line topo-line-grid"></div>
      <div class="topo-line topo-line-home"></div>
      <div class="topo-line topo-line-battery"></div>
    </div>
  `;
  return container;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function updateSystemTopology(state) {
  const container = document.querySelector('.flow-card-2');
  if (!container) return;

  let metricsMap;
  try { metricsMap = JSON.parse(container.dataset.metricMap); }
  catch (e) { return; }

  const m = state.metrics || {};

  const getVal = (role) => {
    const name = metricsMap[role];
    if (!name) return 0;
    return m[name]?.value || 0;
  };

  const solar = getVal('solar');
  const grid = getVal('grid');
  const battPower = getVal('battery_power');
  const battSoc = getVal('battery_soc');
  const consumption = getVal('consumption');
  // Check for discharge metric (battery as source)
  const battDischargeName = metricsMap.battery_power === 'battery_charge' ? 'battery_discharge' : null;
  const battDischarge = battDischargeName ? (m[battDischargeName]?.value || 0) : (battPower < 0 ? Math.abs(battPower) : 0);
  const battIsSource = battDischarge > 50;

  // Update values
  const solarEl = container.querySelector('.topo-solar .topo-value');
  if (solarEl) solarEl.textContent = Math.round(solar) + ' W';

  const gridEl = container.querySelector('.topo-grid-node .topo-value');
  if (gridEl) {
    const gridExport = m[metricsMap.grid === 'grid_import' ? 'grid_export' : metricsMap.grid]?.value || 0;
    const isExport = gridExport > grid;
    gridEl.textContent = isExport ? Math.round(gridExport) + ' W out' : Math.round(grid) + ' W in';
  }

  const homeEl = container.querySelector('.topo-home .topo-value');
  if (homeEl) homeEl.textContent = Math.round(consumption) + ' W';

  const socEl = document.getElementById('topo-battery-soc');
  if (socEl) socEl.textContent = Math.round(battSoc) + '%';

  const battPowerEl = document.getElementById('topo-battery-power');
  if (battPowerEl) {
    if (battPower > 50) battPowerEl.textContent = '↑ ' + Math.round(battPower) + ' W';
    else if (battDischarge > 50) battPowerEl.textContent = '↓ ' + Math.round(battDischarge) + ' W';
    else battPowerEl.textContent = '0 W';
  }

  // Icon colors — match original flow card
  const iconSolar = document.getElementById('topo-icon-solar');
  const iconGrid  = document.getElementById('topo-icon-grid');
  const iconHome  = document.getElementById('topo-icon-home');
  const iconBatt  = document.getElementById('topo-icon-battery');

  if (iconSolar) iconSolar.style.color = solar > 50 ? 'var(--solar)' : 'var(--text-secondary)';
  if (iconHome)  iconHome.style.color  = consumption > 50 ? 'var(--home)' : 'var(--text-secondary)';
  if (iconGrid) {
    if (getVal('grid') < 0) iconGrid.style.color = '#3b82f6'; // exporting
    else if (grid > 50) iconGrid.style.color = 'var(--grid)';
    else iconGrid.style.color = 'var(--text-secondary)';
  }
  if (iconBatt) {
    if (battPower > 50) iconBatt.style.color = 'var(--battery)'; // charging
    else if (battDischarge > 50) iconBatt.style.color = '#f59e0b'; // discharging
    else iconBatt.style.color = 'var(--text-secondary)';
  }

  // Battery icon class based on SOC
  if (iconBatt) {
    let cls = 'fi fi-sr-battery-empty';
    if (battSoc >= 76) cls = 'fi fi-sr-battery-full';
    else if (battSoc >= 51) cls = 'fi fi-sr-battery-three-quarters';
    else if (battSoc >= 26) cls = 'fi fi-sr-battery-half';
    else if (battSoc >= 1) cls = 'fi fi-sr-battery-quarter';
    iconBatt.className = cls;
  }

  // Hub color — reflects active power source
  const hub = container.querySelector('.topo-hub');
  if (hub) {
    if (solar > 100) hub.style.background = 'var(--solar)';
    else if (battIsSource) hub.style.background = '#f59e0b';
    else if (grid > 50) hub.style.background = 'var(--grid)';
    else hub.style.background = 'var(--accent)';
  }

  // Flow lines — active + color + direction
  const lines = container.querySelectorAll('.topo-line');
  lines.forEach(l => { l.classList.remove('active', 'reverse'); l.style.background = ''; });

  if (solar > 100) {
    const l = container.querySelector('.topo-line-solar');
    if (l) { l.classList.add('active'); l.style.background = 'var(--solar)'; }
  }
  if (grid > 50) {
    const l = container.querySelector('.topo-line-grid');
    if (l) { l.classList.add('active'); l.style.background = 'var(--grid)'; }
  } else if (getVal('grid') < 0 && Math.abs(getVal('grid')) > 50) {
    const l = container.querySelector('.topo-line-grid');
    if (l) { l.classList.add('active', 'reverse'); l.style.background = '#3b82f6'; }
  }
  if (consumption > 50) {
    const l = container.querySelector('.topo-line-home');
    if (l) {
      l.classList.add('active');
      if (solar > 100) l.style.background = 'var(--solar)';
      else if (battIsSource) l.style.background = '#f59e0b';
      else l.style.background = 'var(--grid)';
    }
  }
  if (battPower > 50) {
    const l = container.querySelector('.topo-line-battery');
    if (l) { l.classList.add('active'); l.style.background = 'var(--battery)'; }
  } else if (battDischarge > 50) {
    const l = container.querySelector('.topo-line-battery');
    if (l) { l.classList.add('active', 'reverse'); l.style.background = '#f59e0b'; }
  }
}
