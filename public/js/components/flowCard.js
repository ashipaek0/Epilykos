export function buildFlowCard() {
  const card = document.createElement('div');
  card.className = 'flow-card';
  card.innerHTML = `
    <div class="flow-item solar">
      <div class="flow-icon"><i id="icon-solar" class="fi fi-sr-solar-panel"></i></div>
      <div class="flow-label">Solar</div>
      <div class="flow-value" id="flow-solar">0 W</div>
      <div class="solar-now-gauge" id="solar-now-gauge">
        <div class="gauge-bar-bg"><div class="gauge-bar-fill" id="gauge-bar-fill"></div></div>
        <span class="gauge-percent" id="gauge-percent">0%</span>
      </div>
    </div>
    <div class="flow-arrow solar-home">→</div>
    <div class="flow-item battery">
      <div class="flow-icon"><i id="icon-battery" class="fi fi-sr-battery-full"></i></div>
      <div class="flow-label">Battery</div>
      <div class="flow-value" id="flow-battery-soc">--%</div>
      <div class="flow-sub" id="flow-battery-power">⚡ 0 W</div>
    </div>
    <div class="flow-arrow battery">⇄</div>
    <div class="flow-item home">
      <div class="flow-icon"><i id="icon-home" class="fi fi-sr-home"></i></div>
      <div class="flow-label">Home</div>
      <div class="flow-value" id="flow-home">0 W</div>
    </div>
    <div class="flow-arrow grid">⇄</div>
    <div class="flow-item grid">
      <div class="flow-icon"><svg id="icon-grid" viewBox="0 0 512 512" width="1em" height="1em" fill="currentColor"><path d="M426.5 480h-341l34.3-113.3h272.4L426.5 480zM144.8 334.7l34.3-113.4h153.8l34.3 113.4H144.8zM256 92.2l76.3 99.1h-152.6L256 92.2zM32 32h448v40H32z"/></svg></div>
      <div class="flow-label">Grid</div>
      <div class="flow-value" id="flow-grid">0 W</div>
      <div class="flow-sub" id="flow-grid-direction">Import</div>
    </div>
  `;
  return card;
}

export function updateFlowCard(state) {
  if (!state || !state.current || state.current.error) return;
  const d = state.current;
  const solarWatts = Math.round(d.solar_kw * 1000);
  const consumption = Math.round(d.consumption_kw * 1000);
  const battCharge = Math.round(d.battery_charge_kw * 1000);
  const battDischarge = Math.round(d.battery_discharge_kw * 1000);
  const gridImport = Math.round(d.grid_import_kw * 1000);
  const gridExport = Math.round(d.grid_export_kw * 1000);
  const battSoc = d.battery_soc || 0;

  document.getElementById('flow-solar').textContent = solarWatts + ' W';
  document.getElementById('flow-battery-soc').textContent = Math.round(battSoc) + '%';

  const battNet = battCharge - battDischarge;
  const battSign = battNet >= 0 ? '↑' : '↓';
  const battColor = battNet >= 0 ? 'var(--battery)' : '#f59e0b';
  const battEl = document.getElementById('flow-battery-power');
  battEl.innerHTML = '';
  const battSpan = document.createElement('span');
  battSpan.style.color = battColor;
  battSpan.textContent = `${battSign} ${Math.abs(battNet)} W`;
  battEl.appendChild(battSpan);

  document.getElementById('flow-home').textContent = consumption + ' W';

  const gridNet = gridImport - gridExport;
  const gridDir = gridNet >= 0 ? 'Import' : 'Export';
  const gridColor = gridNet >= 0 ? 'var(--grid)' : '#3b82f6';
  const gridEl = document.getElementById('flow-grid');
  gridEl.innerHTML = '';
  const gSpan = document.createElement('span');
  gSpan.style.color = gridColor;
  gSpan.textContent = Math.abs(gridNet) + ' W';
  gridEl.appendChild(gSpan);
  document.getElementById('flow-grid-direction').textContent = gridDir;

  // Icon colors
  const solarIcon = document.getElementById('icon-solar');
  const homeIcon = document.getElementById('icon-home');
  const gridIcon = document.getElementById('icon-grid');
  const batteryIcon = document.getElementById('icon-battery');

  if (solarIcon) solarIcon.style.color = solarWatts > 0 ? 'var(--solar)' : 'var(--text)';
  if (homeIcon) homeIcon.style.color = consumption > 0 ? 'var(--home)' : 'var(--text)';
  if (gridIcon) {
    if (gridNet > 0) gridIcon.style.color = 'var(--grid)';
    else if (gridNet < 0) gridIcon.style.color = '#3b82f6';
    else gridIcon.style.color = 'var(--text)';
  }
  if (batteryIcon) {
    let battClass = 'fi fi-sr-battery-empty';
    if (battSoc >= 76) battClass = 'fi fi-sr-battery-full';
    else if (battSoc >= 51) battClass = 'fi fi-sr-battery-three-quarters';
    else if (battSoc >= 26) battClass = 'fi fi-sr-battery-half';
    else if (battSoc >= 1) battClass = 'fi fi-sr-battery-quarter';
    batteryIcon.className = battClass;
    if (battNet > 0) batteryIcon.style.color = 'var(--battery)';
    else if (battNet < 0) batteryIcon.style.color = '#f59e0b';
    else batteryIcon.style.color = 'var(--text)';
  }

  updateFlowArrows(solarWatts, consumption, battCharge, battDischarge, gridImport, gridExport);
  // Gauge update
  const gaugeFill = document.getElementById('gauge-bar-fill');
  const gaugePercent = document.getElementById('gauge-percent');
  if (gaugeFill && gaugePercent && window.systemCapacityKwp) {
    const percent = Math.min(100, (solarWatts / (window.systemCapacityKwp * 1000)) * 100);
    gaugeFill.style.width = percent + '%';
    gaugePercent.textContent = percent.toFixed(0) + '%';
  }
}

function updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport) {
  const solarArrow = document.querySelector('.flow-arrow.solar-home');
  const battArrow = document.querySelector('.flow-arrow.battery');
  const gridArrow = document.querySelector('.flow-arrow.grid');
  if (solar > 0) {
    if (solarArrow) { solarArrow.style.color = 'var(--solar)'; solarArrow.classList.add('flowing'); solarArrow.textContent = '→'; }
  } else {
    if (solarArrow) { solarArrow.style.color = 'var(--text-secondary)'; solarArrow.classList.remove('flowing'); solarArrow.textContent = '→'; }
  }
  const isCharging = battCharge > battDischarge;
  const isDischarging = battDischarge > battCharge;
  const isGridChargingBattery = gridImport > 0 && isCharging;
  const isSolarChargingBattery = solar > 0 && isCharging && !isGridChargingBattery;
  if (battArrow) {
    if (isDischarging) { battArrow.style.color = '#f59e0b'; battArrow.textContent = '→'; }
    else if (isCharging) {
      if (isGridChargingBattery) { battArrow.style.color = 'var(--grid)'; battArrow.textContent = '←'; }
      else { battArrow.style.color = isSolarChargingBattery ? 'var(--solar)' : 'var(--battery)'; battArrow.textContent = '→'; }
    } else { battArrow.style.color = 'var(--text-secondary)'; battArrow.textContent = '⇄'; }
  }
  if (gridArrow) {
    if (gridImport > gridExport) { gridArrow.style.color = 'var(--grid)'; gridArrow.textContent = '←'; }
    else if (gridExport > gridImport) { gridArrow.style.color = '#3b82f6'; gridArrow.textContent = '→'; }
    else { gridArrow.style.color = 'var(--text-secondary)'; gridArrow.textContent = '⇄'; }
  }
}
