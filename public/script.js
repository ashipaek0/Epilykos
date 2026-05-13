// Minimal working script that loads the dashboard and updates all components
console.log('script loaded and running');

let powerChart;
let energyBarChart;
let sparklineChart;
let dashboardConfig;
let systemCapacityKwp = 2.1;

const componentBuilders = {};

// ─── Theme helpers ─────────────────────────────
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const toggle = document.getElementById('theme-toggle');
  if (savedTheme === 'dark' || (!savedTheme && systemPrefersDark)) {
    document.documentElement.setAttribute('data-theme', 'dark');
    toggle.innerHTML = '<span class="theme-icon">☀️</span>';
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    toggle.innerHTML = '<span class="theme-icon">🌙</span>';
  }
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  document.getElementById('theme-toggle').innerHTML = next === 'dark' ? '<span class="theme-icon">☀️</span>' : '<span class="theme-icon">🌙</span>';
  updateChartColors();
  if (powerChart) applyGradientFills(powerChart);
  updateForecast();
}

function resolveColor(c) { if (c.startsWith('#')) return c; if (c.startsWith('var(--')) { const v = c.slice(4,-1); const s = getComputedStyle(document.documentElement); const r = s.getPropertyValue('--'+v).trim(); if (r.startsWith('#')) return r; } return '#ccc'; }
function applyGradientFills(chart) {
  if (!chart || !chart.ctx) return;
  requestAnimationFrame(() => {
    const ctx = chart.ctx;
    const datasets = chart.data.datasets;
    const area = chart.chartArea;
    if (!area) { setTimeout(() => applyGradientFills(chart), 50); return; }
    datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (!meta.hidden && ds.data.length) {
        const g = ctx.createLinearGradient(0, area.bottom, 0, area.top);
        let col = ds.borderColor || '#ccc';
        const hex = resolveColor(col);
        const r = parseInt(hex.slice(1,3),16), g2 = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        g.addColorStop(0, `rgba(${r},${g2},${b},0.2)`);
        g.addColorStop(0.5, `rgba(${r},${g2},${b},0.5)`);
        g.addColorStop(1, `rgba(${r},${g2},${b},0.8)`);
        ds.backgroundColor = g;
        ds.fill = true;
      }
    });
    chart.update();
  });
}
function updateChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const grid = isDark ? '#334155' : '#cbd5e1';
  const text = isDark ? '#f8fafc' : '#0f172a';
  if (powerChart) {
    powerChart.options.scales.x.grid.color = grid;
    powerChart.options.scales.y.grid.color = grid;
    powerChart.options.plugins.legend.labels.color = text;
    powerChart.data.datasets.forEach((ds,i) => {
      if (i===0) ds.borderColor = isDark ? '#8b5cf6' : '#7c3aed';
      else if (i===1) ds.borderColor = isDark ? '#fbbf24' : '#d97706';
      else if (i===2) ds.borderColor = isDark ? '#10b981' : '#059669';
      else if (i===3) ds.borderColor = isDark ? '#ef4444' : '#dc2626';
    });
    powerChart.update();
    applyGradientFills(powerChart);
  }
  if (energyBarChart) {
    energyBarChart.options.scales.x.grid.color = grid;
    energyBarChart.options.scales.y.grid.color = grid;
    energyBarChart.options.plugins.legend.labels.color = text;
    energyBarChart.update();
  }
}

// ─── Dashboard rendering ──────────────────────
async function loadDashboardConfig() {
  const res = await fetch('/api/dashboard-config');
  dashboardConfig = await res.json();
  renderDashboard();
}
function destroyCharts() {
  if (powerChart) { powerChart.destroy(); powerChart = null; }
  if (energyBarChart) { energyBarChart.destroy(); energyBarChart = null; }
  if (sparklineChart) { sparklineChart.destroy(); sparklineChart = null; }
}
function renderDashboard() {
  const cfg = dashboardConfig;
  if (!cfg || !cfg.dashboards) return;
  destroyCharts();
  let tabBar = document.getElementById('tab-bar');
  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'tab-bar';
    document.querySelector('header').after(tabBar);
  }
  tabBar.innerHTML = '';
  cfg.dashboards.forEach(db => {
    const tab = document.createElement('button');
    tab.className = 'dashboard-tab' + (db.id === cfg.activeDashboard ? ' active' : '');
    tab.textContent = db.name;
    tab.onclick = () => switchDashboard(db.id);
    tabBar.appendChild(tab);
  });
  const container = document.getElementById('dashboard-container');
  container.innerHTML = '';
  const active = cfg.dashboards.find(db => db.id === cfg.activeDashboard);
  if (!active) return;
  active.layout.forEach(block => {
    if (block.enabled === false) return;
    const b = componentBuilders[block.type];
    if (!b) { console.warn('Unknown block:', block.type); return; }
    const el = b(block);
    if (el) container.appendChild(el);
  });
  if (active.layout.some(b => b.type === 'chart-power') && !powerChart) initPowerChart();
  if (active.layout.some(b => b.type === 'chart-energy') && !energyBarChart) initEnergyChart();
  loadBranding();
  updateAllComponents();
}
async function switchDashboard(id) {
  dashboardConfig.activeDashboard = id;
  await fetch('/api/dashboard-config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(dashboardConfig) }).catch(()=>{});
  renderDashboard();
}

// ── Builders ─────────────────────────────────
componentBuilders['flow-card'] = function() {
  const wrapper = document.createElement('div');
  const card = document.createElement('div');
  card.className = 'flow-card';
  card.innerHTML = `
    <div class="flow-item solar"><div class="flow-icon"><i id="icon-solar" class="fi fi-sr-solar-panel"></i></div><div class="flow-label">Solar</div><div class="flow-value" id="flow-solar">0 W</div><div class="solar-now-gauge"><div class="gauge-bar-bg"><div class="gauge-bar-fill" id="gauge-bar-fill"></div></div><span class="gauge-percent" id="gauge-percent">0%</span></div></div>
    <div class="flow-arrow solar-home">→</div>
    <div class="flow-item battery"><div class="flow-icon"><i id="icon-battery" class="fi fi-sr-battery-full"></i></div><div class="flow-label">Battery</div><div class="flow-value" id="flow-battery-soc">--%</div><div class="flow-sub" id="flow-battery-power">⚡ 0 W</div></div>
    <div class="flow-arrow battery">⇄</div>
    <div class="flow-item home"><div class="flow-icon"><i id="icon-home" class="fi fi-sr-home"></i></div><div class="flow-label">Home</div><div class="flow-value" id="flow-home">0 W</div></div>
    <div class="flow-arrow grid">⇄</div>
    <div class="flow-item grid"><div class="flow-icon"><svg id="icon-grid" viewBox="0 0 512 512" width="1em" height="1em" fill="currentColor"><path d="M426.5 480h-341l34.3-113.3h272.4L426.5 480zM144.8 334.7l34.3-113.4h153.8l34.3 113.4H144.8zM256 92.2l76.3 99.1h-152.6L256 92.2zM32 32h448v40H32z"/></svg></div><div class="flow-label">Grid</div><div class="flow-value" id="flow-grid">0 W</div><div class="flow-sub" id="flow-grid-direction">Import</div></div>
  `;
  wrapper.appendChild(card);
  const g2b = document.createElement('div');
  g2b.id = 'grid-to-battery';
  g2b.style.display = 'none';
  g2b.style.textAlign = 'center';
  g2b.style.marginTop = '-0.5rem';
  g2b.style.marginBottom = '1rem';
  g2b.style.color = 'var(--grid)';
  g2b.style.fontSize = '0.9rem';
  g2b.innerHTML = '↑ Grid charging battery ↑';
  wrapper.appendChild(g2b);
  return wrapper;
};

componentBuilders['forecast-banner'] = function() {
  const banner = document.createElement('div');
  banner.className = 'pv-today-banner';
  banner.id = 'forecast-banner';
  banner.style.display = 'none';
  banner.innerHTML = `<div class="pv-top-bar"><h3>Solar Forecast</h3><span class="forecast-date" id="forecast-date"></span></div><div class="pv-main-row"><div class="pv-days"><div class="pv-day"><span class="pv-day-label">Today</span><span class="pv-day-value" id="pv-today-value">0 kWh</span></div><div class="pv-day"><span class="pv-day-label" id="pred-day1-label">Monday</span><span class="pv-day-value" id="pv-tomorrow">0 kWh</span></div><div class="pv-day"><span class="pv-day-label" id="pred-day2-label">Tuesday</span><span class="pv-day-value" id="pv-nextday">0 kWh</span></div></div><div class="weather-section"><div class="weather-column" id="forecast-weather-current"><span class="weather-heading">Current Weather</span><div class="weather-icon-big"><i class="fi fi-sr-sun" id="weather-i"></i></div><div class="weather-details"><span class="weather-temp" id="weather-temp">--°</span><span class="weather-desc" id="weather-desc">--</span><span class="weather-extra" id="weather-extra">--</span></div></div><div class="weather-column" id="forecast-weather-1" style="display:none;"><span class="weather-heading" id="fcast-heading-1">--</span><div class="weather-icon-big"><i class="fi fi-sr-sun" id="fcast-icon-1"></i></div><div class="weather-details"><span class="weather-temp" id="fcast-temp-1">--°</span><span class="weather-desc" id="fcast-desc-1">--</span><span class="weather-extra" id="fcast-extra-1">--</span></div></div><div class="weather-column" id="forecast-weather-2" style="display:none;"><span class="weather-heading" id="fcast-heading-2">--</span><div class="weather-icon-big"><i class="fi fi-sr-sun" id="fcast-icon-2"></i></div><div class="weather-details"><span class="weather-temp" id="fcast-temp-2">--°</span><span class="weather-desc" id="fcast-desc-2">--</span><span class="weather-extra" id="fcast-extra-2">--</span></div></div></div><div class="pv-sparkline-container"><canvas id="pv-sparkline" width="300" height="160"></canvas></div></div>`;
  return banner;
};

componentBuilders['metric-cards'] = function(block) {
  if (!block.cards || !block.cards.length) return document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.id = 'dynamic-stats-grid';
  block.cards.forEach(card => {
    const c = document.createElement('div');
    c.className = 'stat-card';
    c.id = `dynamic-card-${card.id}`;
    c.innerHTML = `<div class="stat-label">${card.title}</div><div class="stat-value" id="val-${card.id}">-- ${card.unit||''}</div>`;
    grid.appendChild(c);
  });
  return grid;
};

componentBuilders['grid-card'] = function() {
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.innerHTML = `<div class="grid-date" id="grid-date"></div><div class="grid-stats"><div class="stat-card"><div class="stat-label">Grid Status</div><div class="stat-value" id="grid-state">--</div><div class="stat-sub" id="grid-last-change"></div></div><div class="stat-card"><div class="stat-label">Today's Grid</div><div class="stat-value" id="grid-hours-day">--</div></div><div class="stat-card"><div class="stat-label">This Week</div><div class="stat-value" id="grid-hours-week">--</div></div><div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value" id="grid-hours-month">--</div></div><div class="stat-card"><div class="stat-label">This Year</div><div class="stat-value" id="grid-hours-year">--</div></div></div><div id="grid-timeline"></div>`;
  return card;
};

componentBuilders['chart-power'] = function() {
  const c = document.createElement('div');
  c.className = 'chart-container';
  c.innerHTML = `<div class="chart-header"><h3>Power Overview</h3><div class="chart-controls"><button data-days="1" class="active">24h</button><button data-days="7">7d</button><button data-days="30">30d</button><button data-days="90">90d</button></div></div><canvas id="powerChart"></canvas>`;
  c.querySelector('.chart-controls').addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON') {
      c.querySelectorAll('.chart-controls button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      updatePowerChartWithDays(parseInt(e.target.dataset.days));
    }
  });
  return c;
};

componentBuilders['chart-energy'] = function() {
  const c = document.createElement('div');
  c.className = 'chart-container';
  c.innerHTML = `<div class="chart-header"><h3>Daily Energy</h3><div class="chart-controls"><button data-days="7" class="active">7d</button><button data-days="30">30d</button><button data-days="90">90d</button></div></div><canvas id="energyBarChart"></canvas>`;
  c.querySelector('.chart-controls').addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON') {
      c.querySelectorAll('.chart-controls button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      updateEnergyChartWithDays(parseInt(e.target.dataset.days));
    }
  });
  return c;
};

componentBuilders['savings-summary'] = function() {
  const g = document.createElement('div');
  g.className = 'stats-grid';
  g.id = 'savings-summary-row';
  g.innerHTML = `<div class="stat-card"><div class="stat-label">PV Savings Today</div><div class="stat-value" id="savings-today">--</div></div><div class="stat-card"><div class="stat-label">PV Savings This Week</div><div class="stat-value" id="savings-week">--</div></div><div class="stat-card"><div class="stat-label">PV Savings This Month</div><div class="stat-value" id="savings-month">--</div></div><div class="stat-card"><div class="stat-label">PV Savings All-Time</div><div class="stat-value" id="savings-all">--</div></div>`;
  return g;
};

componentBuilders['data-table-daily'] = function() {
  const c = document.createElement('div');
  c.className = 'daily-breakdown-container';
  c.style.marginBottom = '1rem';
  c.innerHTML = `<div class="daily-breakdown-header"><h3>Last 30 Days</h3><button class="toggle-btn collapsed">▼</button></div><div class="daily-breakdown-content collapsed"><div class="daily-table-wrapper"><table class="energy-table"><thead><tr><th>Date</th><th>Load</th><th>Solar PV</th><th>Battery charged</th><th>Battery discharged</th><th>Grid used</th><th>Grid exported</th></tr></thead><tbody id="daily-table-body"></tbody></table></div></div>`;
  const btn = c.querySelector('.toggle-btn'), content = c.querySelector('.daily-breakdown-content');
  let loaded = false;
  btn.addEventListener('click', async () => {
    content.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
    if (!loaded && !content.classList.contains('collapsed')) { loaded = true; await updateDailyTable(); }
  });
  return c;
};

componentBuilders['data-table-monthly'] = function() {
  const c = document.createElement('div');
  c.className = 'daily-breakdown-container';
  c.innerHTML = `<div class="daily-breakdown-header"><h3>Last 12 Months</h3><button class="toggle-btn collapsed">▼</button></div><div class="daily-breakdown-content collapsed"><div class="daily-table-wrapper"><table class="energy-table"><thead><tr><th>Month</th><th>Load</th><th>Solar PV</th><th>Battery charged</th><th>Battery discharged</th><th>Grid used</th><th>Grid exported</th></tr></thead><tbody id="monthly-table-body"></tbody></table></div></div>`;
  const btn = c.querySelector('.toggle-btn'), content = c.querySelector('.daily-breakdown-content');
  let loaded = false;
  btn.addEventListener('click', async () => {
    content.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
    if (!loaded && !content.classList.contains('collapsed')) { loaded = true; await updateMonthlyTable(); }
  });
  return c;
};

// ── Charts ────────────────────────────────────
function initPowerChart() {
  const canvas = document.getElementById('powerChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const grid = isDark ? '#334155' : '#cbd5e1';
  const text = isDark ? '#f8fafc' : '#0f172a';
  powerChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index' },
      elements: { line: { borderWidth: 1, tension: 0.4, fill: true }, point: { radius: 0, hoverRadius: 4 } },
      scales: {
        x: { type: 'time', time: { unit: 'hour' }, grid: { color: grid } },
        y: { title: { display: true, text: 'Power (kW)', color: text }, grid: { color: grid } }
      },
      plugins: { tooltip: { mode: 'index' }, legend: { labels: { color: text } } }
    }
  });
}
function initEnergyChart() {
  const canvas = document.getElementById('energyBarChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const grid = isDark ? '#334155' : '#cbd5e1';
  const text = isDark ? '#f8fafc' : '#0f172a';
  energyBarChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Solar Generated', backgroundColor: '#d97706', data: [] },
      { label: 'Grid Imported', backgroundColor: '#dc2626', data: [] },
      { label: 'Energy Consumed', backgroundColor: '#7c3aed', data: [] }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { color: grid } },
        y: { title: { display: true, text: 'Energy (kWh)', color: text }, grid: { color: grid }, beginAtZero: true }
      },
      plugins: { legend: { labels: { color: text } }, tooltip: { mode: 'index' } }
    }
  });
}

// ── Data fetching & updates ───────────────────
async function fetchDashboardState(params = {}) {
  const q = new URLSearchParams();
  if (params.powerDays) q.set('powerDays', params.powerDays);
  if (params.energyDays) q.set('energyDays', params.energyDays);
  const url = '/api/dashboard-state' + (q.toString() ? '?' + q.toString() : '');
  const res = await fetch(url);
  return await res.json();
}

function updateFlowCard(state) {
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
  const battEl = document.getElementById('flow-battery-power');
  battEl.innerHTML = '';
  const sp = document.createElement('span');
  sp.style.color = battNet >= 0 ? 'var(--battery)' : '#f59e0b';
  sp.textContent = `${battNet >= 0 ? '↑' : '↓'} ${Math.abs(battNet)} W`;
  battEl.appendChild(sp);
  document.getElementById('flow-home').textContent = consumption + ' W';
  const gridNet = gridImport - gridExport;
  const gridEl = document.getElementById('flow-grid');
  gridEl.innerHTML = '';
  const gsp = document.createElement('span');
  gsp.style.color = gridNet >= 0 ? 'var(--grid)' : '#3b82f6';
  gsp.textContent = Math.abs(gridNet) + ' W';
  gridEl.appendChild(gsp);
  document.getElementById('flow-grid-direction').textContent = gridNet >= 0 ? 'Import' : 'Export';

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
    let cls = 'fi fi-sr-battery-empty';
    if (battSoc >= 76) cls = 'fi fi-sr-battery-full';
    else if (battSoc >= 51) cls = 'fi fi-sr-battery-three-quarters';
    else if (battSoc >= 26) cls = 'fi fi-sr-battery-half';
    else if (battSoc >= 1) cls = 'fi fi-sr-battery-quarter';
    batteryIcon.className = cls;
    if (battNet > 0) batteryIcon.style.color = 'var(--battery)';
    else if (battNet < 0) batteryIcon.style.color = '#f59e0b';
    else batteryIcon.style.color = 'var(--text)';
  }

  updateFlowArrows(solarWatts, consumption, battCharge, battDischarge, gridImport, gridExport);

  const gaugeFill = document.getElementById('gauge-bar-fill');
  const gaugePercent = document.getElementById('gauge-percent');
  if (gaugeFill && gaugePercent) {
    const percent = systemCapacityKwp > 0 ? Math.min(100, (solarWatts / (systemCapacityKwp * 1000)) * 100) : 0;
    gaugeFill.style.width = percent + '%';
    gaugePercent.textContent = percent.toFixed(0) + '%';
  }
}

function updateFlowArrows(solar, consumption, battCharge, battDischarge, gridImport, gridExport) {
  const solarArrow = document.querySelector('.flow-arrow.solar-home');
  const battArrow = document.querySelector('.flow-arrow.battery');
  const gridArrow = document.querySelector('.flow-arrow.grid');
  const gridToBatt = document.getElementById('grid-to-battery');
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
  if (gridToBatt) gridToBatt.style.display = isGridChargingBattery ? 'block' : 'none';
}

function updateMetricCardsFromState(state) {
  if (!state || !state.metrics) return;
  const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
  if (!activeLayout) return;
  const metricCardsBlock = activeLayout.find(b => b.type === 'metric-cards');
  if (!metricCardsBlock || !metricCardsBlock.cards) return;
  metricCardsBlock.cards.forEach(card => {
    const data = state.metrics[card.metric];
    const cardEl = document.getElementById(`dynamic-card-${card.id}`);
    if (!cardEl) return;
    if (data) {
      cardEl.style.display = '';
      document.getElementById(`val-${card.id}`).textContent = `${data.value.toFixed(1)} ${card.unit || ''}`;
    } else {
      cardEl.style.display = 'none';
    }
  });
}

function updateGridCardFromState(state) {
  if (!state || !state.gridStatus) return;
  const gs = state.gridStatus;
  if (!gs.configured) { document.getElementById('grid-state').textContent = 'Not configured'; return; }
  document.getElementById('grid-state').textContent = gs.current ? '⚡ ON' : '⚫ OFF';
  document.getElementById('grid-state').style.color = gs.current ? 'var(--battery)' : 'var(--grid)';
  const lastChangeEl = document.getElementById('grid-last-change');
  if (lastChangeEl) {
    const lastTimestamp = gs.current ? gs.lastOn : gs.lastOff;
    if (lastTimestamp) {
      const date = new Date(lastTimestamp);
      lastChangeEl.textContent = `${gs.current ? 'ON since' : 'OFF since'} ${date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}, ${date.toLocaleDateString([],{month:'short',day:'numeric'})}`;
    } else lastChangeEl.textContent = '';
  }
  const gh = state.gridHours || {};
  document.getElementById('grid-hours-day').textContent = formatHoursToHM(gh.day||0);
  document.getElementById('grid-hours-week').textContent = formatHoursToHM(gh.week||0);
  document.getElementById('grid-hours-month').textContent = formatHoursToHM(gh.month||0);
  document.getElementById('grid-hours-year').textContent = formatHoursToHM(gh.year||0);
  updateGridDate();
  if (state.gridTimeline && state.gridTimeline.segments) {
    renderTimelineBar(state.gridTimeline.segments, state.gridTimeline.windowStart, state.gridTimeline.windowEnd);
  }
}

function updateSavingsFromState(state) {
  if (!state || !state.savings) return;
  const s = state.savings;
  const curr = s.currency || '€';
  const format = (val) => curr + ' ' + Math.round(val).toLocaleString();
  document.getElementById('savings-today').textContent = format(s.today);
  document.getElementById('savings-week').textContent = format(s.week);
  document.getElementById('savings-month').textContent = format(s.month);
  document.getElementById('savings-all').textContent = format(s.all);
}

function updatePowerChartFromState(state) {
  if (!powerChart || !state || !state.powerHistory) return;
  renderPowerChartData(state.powerHistory);
}
function renderPowerChartData(data) {
  if (!data.length) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const ds = [
    { label:'Load', data:[], borderColor:isDark?'#8b5cf6':'#7c3aed', tension:0.4, borderWidth:1, fill:true },
    { label:'Solar PV', data:[], borderColor:isDark?'#fbbf24':'#d97706', tension:0.4, borderWidth:1, fill:true },
    { label:'Battery Charge', data:[], borderColor:isDark?'#10b981':'#059669', tension:0.4, borderWidth:1, fill:true },
    { label:'Grid Import', data:[], borderColor:isDark?'#ef4444':'#dc2626', tension:0.4, borderWidth:1, fill:true }
  ];
  data.forEach(d => {
    ds[0].data.push({ x:d.timestamp, y:d.consumption_kw });
    ds[1].data.push({ x:d.timestamp, y:d.solar_kw });
    ds[2].data.push({ x:d.timestamp, y:d.battery_charge_kw });
    ds[3].data.push({ x:d.timestamp, y:d.grid_import_kw });
  });
  powerChart.data.datasets = ds;
  powerChart.update();
  applyGradientFills(powerChart);
}
async function updatePowerChartWithDays(days) {
  if (!powerChart) return;
  const state = await fetchDashboardState({ powerDays: days });
  if (state && state.powerHistory) renderPowerChartData(state.powerHistory);
}

function updateEnergyChartFromState(state) {
  if (!energyBarChart || !state || !state.dailyEnergyBar) return;
  renderEnergyChartData(state.dailyEnergyBar);
}
function renderEnergyChartData(data) {
  if (!data.length) return;
  const labels = data.map(d => new Date(d.day+'T00:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}));
  energyBarChart.data.labels = labels;
  energyBarChart.data.datasets[0].data = data.map(d => d.solar_kwh);
  energyBarChart.data.datasets[1].data = data.map(d => d.grid_import_kwh);
  energyBarChart.data.datasets[2].data = data.map(d => d.consumption_kwh);
  energyBarChart.update();
}
async function updateEnergyChartWithDays(days) {
  if (!energyBarChart) return;
  const state = await fetchDashboardState({ energyDays: days });
  if (state && state.dailyEnergyBar) renderEnergyChartData(state.dailyEnergyBar);
}

async function updateDailyTable() {
  const tbody = document.getElementById('daily-table-body');
  if (!tbody) return;
  try {
    const res = await fetch('/api/daily?days=30');
    const data = await res.json();
    tbody.innerHTML = '';
    data.reverse().forEach(row => {
      const date = new Date(row.day+'T00:00:00');
      const formattedDate = date.toLocaleDateString(undefined,{month:'short',day:'numeric'});
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formattedDate}</td><td>${row.consumption_kwh.toFixed(1)} kWh</td><td>${row.solar_kwh.toFixed(1)} kWh</td><td>${row.battery_charge_kwh.toFixed(1)} kWh</td><td>${row.battery_discharge_kwh.toFixed(1)} kWh</td><td>${row.grid_import_kwh.toFixed(1)} kWh</td><td>${row.grid_export_kwh.toFixed(1)} kWh</td>`;
      tbody.appendChild(tr);
    });
  } catch(e) { console.error(e); }
}

async function updateMonthlyTable() {
  const tbody = document.getElementById('monthly-table-body');
  if (!tbody) return;
  try {
    const res = await fetch('/api/monthly');
    const data = await res.json();
    tbody.innerHTML = '';
    data.reverse().forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.month}</td><td>${row.consumption_kwh.toFixed(1)} kWh</td><td>${row.solar_kwh.toFixed(1)} kWh</td><td>${row.battery_charge_kwh.toFixed(1)} kWh</td><td>${row.battery_discharge_kwh.toFixed(1)} kWh</td><td>${row.grid_import_kwh.toFixed(1)} kWh</td><td>${row.grid_export_kwh.toFixed(1)} kWh</td>`;
      tbody.appendChild(tr);
    });
  } catch(e) { console.error(e); }
}

async function updateForecast() { /* unchanged – same as before */ }

function setWeatherIconColor() { /* unchanged */ }
function getDayName() { /* unchanged */ }
function formatHoursToHM(hours) { const totalMinutes = Math.round(hours * 60); const h = Math.floor(totalMinutes / 60); const m = totalMinutes % 60; return `${String(h).padStart(2,'0')}h:${String(m).padStart(2,'0')}m`; }
function updateGridDate() {
  const dateEl = document.getElementById('grid-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}
function renderTimelineBar() { /* unchanged */ }

async function loadBranding() {
  try {
    const res = await fetch('/api/public-config');
    const cfg = await res.json();
    if (cfg.dashboard_title) { document.getElementById('dashboard-title').textContent = cfg.dashboard_title; document.title = cfg.dashboard_title; }
    if (cfg.dashboard_logo) { document.getElementById('logo-img').src = cfg.dashboard_logo; document.getElementById('logo-img').style.display = 'inline'; }
    if (cfg.solar_capacity_kwp) systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
  } catch(e) {}
}

async function updateAllComponents() {
  try {
    const state = await fetchDashboardState();
    const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
    if (!activeLayout) return;
    if (activeLayout.some(b => b.type === 'flow-card')) updateFlowCard(state);
    if (activeLayout.some(b => b.type === 'metric-cards')) updateMetricCardsFromState(state);
    if (activeLayout.some(b => b.type === 'grid-card')) updateGridCardFromState(state);
    if (activeLayout.some(b => b.type === 'chart-power')) updatePowerChartFromState(state);
    if (activeLayout.some(b => b.type === 'chart-energy')) updateEnergyChartFromState(state);
    if (activeLayout.some(b => b.type === 'savings-summary')) updateSavingsFromState(state);
    updateForecast();
  } catch(e) { console.error(e); }
}

// ─── Init ─────────────────────────────────────
initTheme();
loadDashboardConfig().then(() => {
  setInterval(updateAllComponents, 30000);
});
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
