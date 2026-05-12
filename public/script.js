let powerChart;
let energyBarChart;
let sparklineChart;
let dashboardConfig;
let systemCapacityKwp = 2.1;

const componentBuilders = {};

// ─── Theme & Color helpers ────────────────────────────────────────────────
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const themeToggle = document.getElementById('theme-toggle');
  if (savedTheme === 'dark' || (!savedTheme && systemPrefersDark)) {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeToggle.innerHTML = '<span class="theme-icon">☀️</span>';
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    themeToggle.innerHTML = '<span class="theme-icon">🌙</span>';
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  document.getElementById('theme-toggle').innerHTML = newTheme === 'dark' ? '<span class="theme-icon">☀️</span>' : '<span class="theme-icon">🌙</span>';
  updateChartColors();
  if (powerChart) applyGradientFills(powerChart);
  updateForecast();
}

function resolveColor(color) {
  if (color.startsWith('#')) return color;
  if (color.startsWith('var(--')) {
    const varName = color.slice(4, -1);
    const style = getComputedStyle(document.documentElement);
    const raw = style.getPropertyValue('--' + varName).trim();
    if (raw.startsWith('#')) return raw;
  }
  return '#cccccc';
}

function applyGradientFills(chart) {
  if (!chart || !chart.ctx) return;
  requestAnimationFrame(() => {
    const ctx = chart.ctx;
    const datasets = chart.data.datasets;
    const chartArea = chart.chartArea;
    if (!chartArea) {
      setTimeout(() => applyGradientFills(chart), 50);
      return;
    }
    datasets.forEach((dataset, i) => {
      const meta = chart.getDatasetMeta(i);
      if (!meta.hidden && dataset.data.length > 0) {
        const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
        let color = dataset.borderColor || '#ccc';
        const hex = resolveColor(color);
        const r = parseInt(hex.slice(1,3), 16);
        const g = parseInt(hex.slice(3,5), 16);
        const b = parseInt(hex.slice(5,7), 16);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.2)`);
        gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.5)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.8)`);
        dataset.backgroundColor = gradient;
        dataset.fill = true;
      }
    });
    chart.update();
  });
}

function updateChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  if (powerChart) {
    powerChart.options.scales.x.grid.color = gridColor;
    powerChart.options.scales.y.grid.color = gridColor;
    powerChart.options.plugins.legend.labels.color = textColor;
    powerChart.data.datasets.forEach((ds, i) => {
      if (i === 0) ds.borderColor = isDark ? '#8b5cf6' : '#7c3aed';
      else if (i === 1) ds.borderColor = isDark ? '#fbbf24' : '#d97706';
      else if (i === 2) ds.borderColor = isDark ? '#10b981' : '#059669';
      else if (i === 3) ds.borderColor = isDark ? '#ef4444' : '#dc2626';
    });
    powerChart.update();
    applyGradientFills(powerChart);
  }
  if (energyBarChart) {
    energyBarChart.options.scales.x.grid.color = gridColor;
    energyBarChart.options.scales.y.grid.color = gridColor;
    energyBarChart.options.plugins.legend.labels.color = textColor;
    energyBarChart.update();
  }
}

// ─── Dashboard Config & Rendering ─────────────────────────────────────────
async function loadDashboardConfig() {
  const res = await fetch('/api/dashboard-config');
  dashboardConfig = await res.json();
  renderDashboard();
}

function renderDashboard() {
  const config = dashboardConfig;
  if (!config || !config.dashboards) return;

  // Build tab bar
  let tabBar = document.getElementById('tab-bar');
  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'tab-bar';
    const header = document.querySelector('header');
    header.after(tabBar);
  }
  tabBar.innerHTML = '';
  config.dashboards.forEach(db => {
    const tab = document.createElement('button');
    tab.className = 'dashboard-tab' + (db.id === config.activeDashboard ? ' active' : '');
    tab.textContent = db.name;
    tab.onclick = () => switchDashboard(db.id);
    tabBar.appendChild(tab);
  });

  // Clear previous dashboard content
  const container = document.getElementById('dashboard-container');
  container.innerHTML = '';

  const active = config.dashboards.find(db => db.id === config.activeDashboard);
  if (!active) return;

  // Render blocks in order
  active.layout.forEach(block => {
    if (block.enabled === false) return;
    const builder = componentBuilders[block.type];
    if (!builder) {
      console.warn(`Unknown component type: ${block.type}`);
      return;
    }
    const el = builder(block);
    if (el) container.appendChild(el);
  });

  // Initialize charts if needed
  if (active.layout.some(b => b.type === 'chart-power') && !powerChart) {
    initPowerChart();
  }
  if (active.layout.some(b => b.type === 'chart-energy') && !energyBarChart) {
    initEnergyChart();
  }

  loadBranding();
  updateAllComponents();
}

async function switchDashboard(id) {
  dashboardConfig.activeDashboard = id;
  try {
    await fetch('/api/dashboard-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dashboardConfig)
    });
  } catch (e) { console.error(e); }
  renderDashboard();
}

// ─── Component Builders ───────────────────────────────────────────────────
componentBuilders['flow-card'] = function() {
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
      <div class="flow-icon">
        <svg id="icon-grid" viewBox="0 0 512 512" width="1em" height="1em" fill="currentColor">
          <path d="M426.5 480h-341l34.3-113.3h272.4L426.5 480zM144.8 334.7l34.3-113.4h153.8l34.3 113.4H144.8zM256 92.2l76.3 99.1h-152.6L256 92.2zM32 32h448v40H32z"/>
        </svg>
      </div>
      <div class="flow-label">Grid</div>
      <div class="flow-value" id="flow-grid">0 W</div>
      <div class="flow-sub" id="flow-grid-direction">Import</div>
    </div>
  `;
  return card;
};

componentBuilders['forecast-banner'] = function() {
  const banner = document.createElement('div');
  banner.className = 'pv-today-banner';
  banner.id = 'forecast-banner';
  banner.style.display = 'none';
  banner.innerHTML = `
    <div class="pv-top-bar">
      <h3>Solar Forecast</h3>
      <span class="forecast-date" id="forecast-date"></span>
    </div>
    <div class="pv-main-row">
      <div class="pv-days">
        <div class="pv-day">
          <span class="pv-day-label">Today</span>
          <span class="pv-day-value" id="pv-today-value">0 kWh</span>
        </div>
        <div class="pv-day">
          <span class="pv-day-label" id="pred-day1-label">Monday</span>
          <span class="pv-day-value" id="pv-tomorrow">0 kWh</span>
        </div>
        <div class="pv-day">
          <span class="pv-day-label" id="pred-day2-label">Tuesday</span>
          <span class="pv-day-value" id="pv-nextday">0 kWh</span>
        </div>
      </div>
      <div class="weather-section">
        <div class="weather-column" id="forecast-weather-current">
          <span class="weather-heading">Current Weather</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="weather-i"></i></div>
          <div class="weather-details">
            <span class="weather-temp" id="weather-temp">--°</span>
            <span class="weather-desc" id="weather-desc">--</span>
            <span class="weather-extra" id="weather-extra">--</span>
          </div>
        </div>
        <div class="weather-column" id="forecast-weather-1" style="display:none;">
          <span class="weather-heading" id="fcast-heading-1">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="fcast-icon-1"></i></div>
          <div class="weather-details">
            <span class="weather-temp" id="fcast-temp-1">--°</span>
            <span class="weather-desc" id="fcast-desc-1">--</span>
            <span class="weather-extra" id="fcast-extra-1">--</span>
          </div>
        </div>
        <div class="weather-column" id="forecast-weather-2" style="display:none;">
          <span class="weather-heading" id="fcast-heading-2">--</span>
          <div class="weather-icon-big"><i class="fi fi-sr-sun" id="fcast-icon-2"></i></div>
          <div class="weather-details">
            <span class="weather-temp" id="fcast-temp-2">--°</span>
            <span class="weather-desc" id="fcast-desc-2">--</span>
            <span class="weather-extra" id="fcast-extra-2">--</span>
          </div>
        </div>
      </div>
      <div class="pv-sparkline-container">
        <canvas id="pv-sparkline" width="300" height="160"></canvas>
      </div>
    </div>
  `;
  return banner;
};

componentBuilders['metric-cards'] = function(block) {
  if (!block.cards || !block.cards.length) return document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.id = 'dynamic-stats-grid';
  block.cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'stat-card';
    cardEl.id = `dynamic-card-${card.id}`;
    cardEl.innerHTML = `
      <div class="stat-label">${card.title}</div>
      <div class="stat-value" id="val-${card.id}">-- ${card.unit || ''}</div>
    `;
    grid.appendChild(cardEl);
  });
  return grid;
};

componentBuilders['grid-card'] = function() {
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
    <div id="grid-timeline"></div>
  `;
  return card;
};

componentBuilders['chart-power'] = function() {
  const container = document.createElement('div');
  container.className = 'chart-container';
  container.innerHTML = `
    <div class="chart-header"><h3>Power Overview</h3></div>
    <canvas id="powerChart"></canvas>
  `;
  return container;
};

componentBuilders['chart-energy'] = function() {
  const container = document.createElement('div');
  container.className = 'chart-container';
  container.innerHTML = `
    <div class="chart-header"><h3>Daily Energy</h3></div>
    <canvas id="energyBarChart"></canvas>
  `;
  return container;
};

componentBuilders['savings-summary'] = function() {
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.id = 'savings-summary-row';
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-label">PV Savings Today</div><div class="stat-value" id="savings-today">--</div></div>
    <div class="stat-card"><div class="stat-label">PV Savings This Week</div><div class="stat-value" id="savings-week">--</div></div>
    <div class="stat-card"><div class="stat-label">PV Savings This Month</div><div class="stat-value" id="savings-month">--</div></div>
    <div class="stat-card"><div class="stat-label">PV Savings All-Time</div><div class="stat-value" id="savings-all">--</div></div>
  `;
  return grid;
};

componentBuilders['data-table-daily'] = function() {
  const container = document.createElement('div');
  container.className = 'daily-breakdown-container';
  container.style.marginBottom = '1rem';
  container.innerHTML = `
    <div class="daily-breakdown-header">
      <h3>Last 30 Days</h3>
      <button class="toggle-btn">▼</button>
    </div>
    <div class="daily-breakdown-content">
      <div class="daily-table-wrapper">
        <table class="energy-table">
          <thead><tr><th>Date</th><th>Load</th><th>Solar PV</th><th>Battery charged</th><th>Battery discharged</th><th>Grid used</th><th>Grid exported</th></tr></thead>
          <tbody id="daily-table-body"></tbody>
        </table>
      </div>
    </div>
  `;
  const toggleBtn = container.querySelector('.toggle-btn');
  const content = container.querySelector('.daily-breakdown-content');
  toggleBtn.addEventListener('click', () => {
    content.classList.toggle('collapsed');
    toggleBtn.classList.toggle('collapsed');
  });
  return container;
};

componentBuilders['data-table-monthly'] = function() {
  const container = document.createElement('div');
  container.className = 'daily-breakdown-container';
  container.innerHTML = `
    <div class="daily-breakdown-header">
      <h3>Last 12 Months</h3>
      <button class="toggle-btn">▼</button>
    </div>
    <div class="daily-breakdown-content">
      <div class="daily-table-wrapper">
        <table class="energy-table">
          <thead><tr><th>Month</th><th>Load</th><th>Solar PV</th><th>Battery charged</th><th>Battery discharged</th><th>Grid used</th><th>Grid exported</th></tr></thead>
          <tbody id="monthly-table-body"></tbody>
        </table>
      </div>
    </div>
  `;
  const toggleBtn = container.querySelector('.toggle-btn');
  const content = container.querySelector('.daily-breakdown-content');
  toggleBtn.addEventListener('click', () => {
    content.classList.toggle('collapsed');
    toggleBtn.classList.toggle('collapsed');
  });
  return container;
};

// ─── Chart Initialization ─────────────────────────────────────────────────
function initPowerChart() {
  const canvas = document.getElementById('powerChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  powerChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index' },
      elements: { line: { borderWidth: 1, tension: 0.4, fill: true }, point: { radius: 0, hoverRadius: 4 } },
      scales: {
        x: { type: 'time', time: { unit: 'hour' }, grid: { color: gridColor } },
        y: { title: { display: true, text: 'Power (kW)', color: textColor }, grid: { color: gridColor } }
      },
      plugins: {
        tooltip: { mode: 'index' },
        legend: { labels: { color: textColor } }
      }
    }
  });
}

function initEnergyChart() {
  const canvas = document.getElementById('energyBarChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  energyBarChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Solar Generated', backgroundColor: '#d97706', data: [] },
        { label: 'Grid Imported', backgroundColor: '#dc2626', data: [] },
        { label: 'Energy Consumed', backgroundColor: '#7c3aed', data: [] }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { color: gridColor } },
        y: { title: { display: true, text: 'Energy (kWh)', color: textColor }, grid: { color: gridColor }, beginAtZero: true }
      },
      plugins: { legend: { labels: { color: textColor } }, tooltip: { mode: 'index' } }
    }
  });
}

// ─── Data Update Functions ────────────────────────────────────────────────
async function updateFlowCard() {
  try {
    const res = await fetch('/api/current');
    const d = await res.json();
    document.getElementById('flow-solar').textContent = Math.round(d.solar_kw * 1000) + ' W';
    document.getElementById('flow-battery-soc').textContent = Math.round(d.battery_soc) + '%';

    const battNet = (d.battery_charge_kw - d.battery_discharge_kw) * 1000;
    const battEl = document.getElementById('flow-battery-power');
    battEl.innerHTML = '';
    const span = document.createElement('span');
    span.style.color = battNet >= 0 ? 'var(--battery)' : '#f59e0b';
    span.textContent = `${battNet >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(battNet))} W`;
    battEl.appendChild(span);

    document.getElementById('flow-home').textContent = Math.round(d.consumption_kw * 1000) + ' W';

    const gridNet = (d.grid_import_kw - d.grid_export_kw) * 1000;
    const gridEl = document.getElementById('flow-grid');
    gridEl.innerHTML = '';
    const gSpan = document.createElement('span');
    gSpan.style.color = gridNet >= 0 ? 'var(--grid)' : '#3b82f6';
    gSpan.textContent = Math.abs(Math.round(gridNet)) + ' W';
    gridEl.appendChild(gSpan);
    document.getElementById('flow-grid-direction').textContent = gridNet >= 0 ? 'Import' : 'Export';

    const gaugeFill = document.getElementById('gauge-bar-fill');
    const gaugePercent = document.getElementById('gauge-percent');
    if (gaugeFill && gaugePercent) {
      const percent = systemCapacityKwp > 0 ? Math.min(100, (d.solar_kw / systemCapacityKwp) * 100) : 0;
      gaugeFill.style.width = percent + '%';
      gaugePercent.textContent = percent.toFixed(0) + '%';
    }

    // Icon colors
    const solarIcon = document.getElementById('icon-solar');
    const homeIcon = document.getElementById('icon-home');
    const gridIcon = document.getElementById('icon-grid');
    if (solarIcon) solarIcon.style.color = d.solar_kw > 0 ? 'var(--solar)' : 'var(--text)';
    if (homeIcon) homeIcon.style.color = d.consumption_kw > 0 ? 'var(--home)' : 'var(--text)';
    if (gridIcon) {
      if (gridNet > 0) gridIcon.style.color = 'var(--grid)';
      else if (gridNet < 0) gridIcon.style.color = '#3b82f6';
      else gridIcon.style.color = 'var(--text)';
    }
    const batteryIcon = document.getElementById('icon-battery');
    if (batteryIcon) {
      let cls = 'fi fi-sr-battery-empty';
      if (d.battery_soc >= 76) cls = 'fi fi-sr-battery-full';
      else if (d.battery_soc >= 51) cls = 'fi fi-sr-battery-three-quarters';
      else if (d.battery_soc >= 26) cls = 'fi fi-sr-battery-half';
      else if (d.battery_soc >= 1) cls = 'fi fi-sr-battery-quarter';
      batteryIcon.className = cls;
      if (battNet > 0) batteryIcon.style.color = 'var(--battery)';
      else if (battNet < 0) batteryIcon.style.color = '#f59e0b';
      else batteryIcon.style.color = 'var(--text)';
    }
  } catch (e) { console.error(e); }
}

async function updateMetricCards() {
  const res = await fetch('/api/metrics/current');
  const metrics = await res.json();
  const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
  if (!activeLayout) return;
  const metricCardsBlock = activeLayout.find(b => b.type === 'metric-cards');
  if (!metricCardsBlock || !metricCardsBlock.cards) return;
  metricCardsBlock.cards.forEach(card => {
    const data = metrics[card.metric];
    const cardEl = document.getElementById(`dynamic-card-${card.id}`);
    if (!cardEl) return;
    if (data) {
      cardEl.style.display = '';
      const valEl = document.getElementById(`val-${card.id}`);
      if (valEl) valEl.textContent = `${data.value.toFixed(1)} ${card.unit || ''}`;
    } else {
      cardEl.style.display = 'none';
    }
  });
}

async function updateGridCard() {
  try {
    const res = await fetch('/api/grid/status');
    const d = await res.json();
    if (!d.configured) {
      document.getElementById('grid-state').textContent = 'Not configured';
      return;
    }
    document.getElementById('grid-state').textContent = d.current ? '⚡ ON' : '⚫ OFF';
    document.getElementById('grid-state').style.color = d.current ? 'var(--battery)' : 'var(--grid)';

    const periods = ['day', 'week', 'month', 'year'];
    for (const p of periods) {
      const hRes = await fetch(`/api/grid/hours?period=${p}`);
      const hData = await hRes.json();
      document.getElementById(`grid-hours-${p}`).textContent = formatHoursToHM(hData.hours);
    }

    updateGridDate();

    const timelineRes = await fetch('/api/grid/timeline?period=24h');
    const timelineData = await timelineRes.json();
    if (timelineData.configured && timelineData.segments) {
      renderTimelineBar(timelineData.segments, timelineData.windowStart, timelineData.windowEnd);
    }
  } catch (e) { console.error('Grid card error:', e); }
}

function updateGridDate() {
  const dateEl = document.getElementById('grid-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  }
}

function renderTimelineBar(segments, windowStart, windowEnd) {
  const container = document.getElementById('grid-timeline');
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

    el.addEventListener('mouseenter', () => {
      tooltip.style.display = 'block';
      tooltip.textContent = `${seg.state === 1 ? 'ON' : 'OFF'} since ${new Date(seg.start).toLocaleString()} until ${segEnd < windowEnd ? new Date(segEnd).toLocaleString() : 'Now'}`;
      const barRect = bar.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      tooltip.style.left = (elRect.left - barRect.left + elRect.width / 2) + 'px';
      tooltip.style.top = (-tooltip.offsetHeight - 8) + 'px';
    });
    el.addEventListener('mouseleave', () => tooltip.style.display = 'none');
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

async function updateSavings() {
  try {
    const res = await fetch('/api/savings');
    const d = await res.json();
    const curr = d.currency || '€';
    const format = (val) => curr + ' ' + Math.round(val).toLocaleString();
    document.getElementById('savings-today').textContent = format(d.today);
    document.getElementById('savings-week').textContent = format(d.week);
    document.getElementById('savings-month').textContent = format(d.month);
    document.getElementById('savings-all').textContent = format(d.all);
  } catch (e) { console.error('Savings error:', e); }
}

async function updatePowerChart(days = 1) {
  if (!powerChart) return;
  try {
    const res = await fetch(`/api/history?days=${days}`);
    const data = await res.json();
    if (!data.length) return;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newDatasets = [
      { label: 'Load', data: [], borderColor: isDark ? '#8b5cf6' : '#7c3aed', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Solar PV', data: [], borderColor: isDark ? '#fbbf24' : '#d97706', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Battery Charge', data: [], borderColor: isDark ? '#10b981' : '#059669', tension: 0.4, borderWidth: 1, fill: true },
      { label: 'Grid Import', data: [], borderColor: isDark ? '#ef4444' : '#dc2626', tension: 0.4, borderWidth: 1, fill: true }
    ];
    data.forEach(d => {
      newDatasets[0].data.push({ x: d.timestamp, y: d.consumption_kw });
      newDatasets[1].data.push({ x: d.timestamp, y: d.solar_kw });
      newDatasets[2].data.push({ x: d.timestamp, y: d.battery_charge_kw });
      newDatasets[3].data.push({ x: d.timestamp, y: d.grid_import_kw });
    });
    powerChart.data.datasets = newDatasets;
    powerChart.update();
    applyGradientFills(powerChart);
  } catch (e) { console.error(e); }
}

async function updateEnergyChart() {
  if (!energyBarChart) return;
  try {
    const res = await fetch('/api/daily?days=7');
    const data = await res.json();
    if (!data.length) return;
    const labels = data.map(d => {
      const date = new Date(d.day + 'T00:00:00');
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });
    energyBarChart.data.labels = labels;
    energyBarChart.data.datasets[0].data = data.map(d => d.solar_kwh);
    energyBarChart.data.datasets[1].data = data.map(d => d.grid_import_kwh);
    energyBarChart.data.datasets[2].data = data.map(d => d.consumption_kwh);
    energyBarChart.update();
  } catch (e) { console.error(e); }
}

async function updateDailyTable() {
  const tbody = document.getElementById('daily-table-body');
  if (!tbody) return;
  try {
    const res = await fetch('/api/daily?days=30');
    const data = await res.json();
    tbody.innerHTML = '';
    data.reverse().forEach(row => {
      const date = new Date(row.day + 'T00:00:00');
      const formattedDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formattedDate}</td><td>${row.consumption_kwh.toFixed(1)} kWh</td><td>${row.solar_kwh.toFixed(1)} kWh</td><td>${row.battery_charge_kwh.toFixed(1)} kWh</td><td>${row.battery_discharge_kwh.toFixed(1)} kWh</td><td>${row.grid_import_kwh.toFixed(1)} kWh</td><td>${row.grid_export_kwh.toFixed(1)} kWh</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
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
  } catch (e) { console.error(e); }
}

async function updateForecast() {
  const banner = document.getElementById('forecast-banner');
  if (!banner) return;
  try {
    const res = await fetch('/api/solar-forecast');
    const data = await res.json();
    if (data.error || !data.daily || data.daily.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'block';

    const now = new Date();
    const todayDate = now.toLocaleDateString('en-CA');
    let todayIdx = data.daily.findIndex(d => d.date === todayDate);
    if (todayIdx === -1) todayIdx = 0;
    const today = data.daily[todayIdx];
    const tomorrow = data.daily[todayIdx + 1] || null;
    const nextDay = data.daily[todayIdx + 2] || null;

    document.getElementById('pv-today-value').textContent = (today.total_kwh || 0).toFixed(1) + ' kWh';
    if (tomorrow) {
      document.getElementById('pred-day1-label').textContent = getDayName(tomorrow.date);
      document.getElementById('pv-tomorrow').textContent = tomorrow.total_kwh.toFixed(1) + ' kWh';
    } else {
      document.getElementById('pred-day1-label').textContent = '--';
      document.getElementById('pv-tomorrow').textContent = '-- kWh';
    }
    if (nextDay) {
      document.getElementById('pred-day2-label').textContent = getDayName(nextDay.date);
      document.getElementById('pv-nextday').textContent = nextDay.total_kwh.toFixed(1) + ' kWh';
    } else {
      document.getElementById('pred-day2-label').textContent = '--';
      document.getElementById('pv-nextday').textContent = '-- kWh';
    }
    document.getElementById('forecast-date').textContent =
      now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    // Weather
    if (data.weather) {
      const w = data.weather;
      document.getElementById('weather-i').className = w.icon_class || 'fi fi-sr-sun';
      document.getElementById('weather-temp').textContent = w.temp != null ? w.temp.toFixed(0) + '°C' : '--°';
      document.getElementById('weather-desc').textContent = w.desc || '';
      document.getElementById('weather-extra').textContent = w.extra || '';
      setWeatherIconColor(document.getElementById('weather-i'), w.desc);

      const forecastWeather = w.forecast_weather || [];
      const col1 = document.getElementById('forecast-weather-1');
      const fw1 = forecastWeather[0];
      if (fw1 && fw1.temp != null) {
        document.getElementById('fcast-heading-1').textContent = fw1.day_name || '--';
        document.getElementById('fcast-icon-1').className = fw1.icon_class;
        document.getElementById('fcast-temp-1').textContent = fw1.temp.toFixed(0) + '°C';
        document.getElementById('fcast-desc-1').textContent = fw1.desc || '';
        document.getElementById('fcast-extra-1').textContent = fw1.extra || '';
        setWeatherIconColor(document.getElementById('fcast-icon-1'), fw1.desc);
        col1.style.display = '';
      } else {
        col1.style.display = 'none';
      }

      const col2 = document.getElementById('forecast-weather-2');
      const fw2 = forecastWeather[1];
      if (fw2 && fw2.temp != null) {
        document.getElementById('fcast-heading-2').textContent = fw2.day_name || '--';
        document.getElementById('fcast-icon-2').className = fw2.icon_class;
        document.getElementById('fcast-temp-2').textContent = fw2.temp.toFixed(0) + '°C';
        document.getElementById('fcast-desc-2').textContent = fw2.desc || '';
        document.getElementById('fcast-extra-2').textContent = fw2.extra || '';
        setWeatherIconColor(document.getElementById('fcast-icon-2'), fw2.desc);
        col2.style.display = '';
      } else {
        col2.style.display = 'none';
      }
    }

    // Sparkline
    const canvasSpark = document.getElementById('pv-sparkline');
    if (canvasSpark) {
      if (!sparklineChart) {
        const ctx = canvasSpark.getContext('2d');
        sparklineChart = new Chart(ctx, {
          type: 'line',
          data: { datasets: [] },
          options: {
            responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' },
            elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0 } },
            scales: {
              x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'HH' } }, grid: { display: false } },
              y: { beginAtZero: true, max: 1 }
            },
            plugins: { tooltip: { enabled: false }, legend: { display: true } }
          }
        });
      }

      const historyRes = await fetch('/api/history?days=1');
      const historyData = await historyRes.json();

      const actualPoints = historyData
        .filter(d => {
          const date = new Date(d.timestamp);
          return date.toLocaleDateString('en-CA') === todayDate && date.getHours() >= 7 && date.getHours() <= 19;
        })
        .map(d => ({ x: d.timestamp, y: d.solar_kw }));

      const intervals = [];
      for (let h = 7; h <= 19; h += 0.5) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(h), (h % 1) * 60, 0);
        intervals.push(start.getTime());
      }

      const actualByInterval = {};
      actualPoints.forEach(p => {
        const d = new Date(p.x);
        const bucketMinute = Math.floor(d.getMinutes() / 30) * 30;
        const bucketTime = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), bucketMinute, 0).getTime();
        if (!actualByInterval[bucketTime]) actualByInterval[bucketTime] = [];
        actualByInterval[bucketTime].push(p.y);
      });

      const actualData = intervals.map(ts => {
        const values = actualByInterval[ts] || [];
        if (values.length === 0) return null;
        return { x: ts, y: values.reduce((a,b) => a+b, 0) / values.length };
      }).filter(p => p !== null && p.x <= now.getTime());

      let forecastHourly = (data.hourly || [])
        .filter(h => {
          const d = new Date(h.period_end);
          return d.toLocaleDateString('en-CA') === todayDate && d.getHours() >= 7 && d.getHours() <= 19;
        })
        .map(h => ({ x: new Date(h.period_end).getTime(), y: h.pv_estimate }));

      const sevenAM = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7,0,0).getTime();
      if (forecastHourly.length === 0 || forecastHourly[0].x > sevenAM) {
        forecastHourly.unshift({ x: sevenAM, y: 0 });
      }
      forecastHourly.sort((a,b) => a.x - b.x);

      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const actualColor = '#3b82f6';
      const forecastColor = isDark ? '#fbbf24' : '#d97706';

      sparklineChart.data.datasets = [
        { label: 'Actual', data: actualData, borderColor: actualColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: false, borderDash: [] },
        { label: 'Forecast', data: forecastHourly, borderColor: forecastColor, backgroundColor: 'transparent', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, borderDash: [5,5] }
      ];

      sparklineChart.update();

      const chartArea = sparklineChart.chartArea;
      if (chartArea && sparklineChart.data.datasets[1].data.length > 0) {
        const ctx = sparklineChart.ctx;
        const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
        const hex = forecastColor;
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        gradient.addColorStop(0, `rgba(${r},${g},${b},0.1)`);
        gradient.addColorStop(0.5, `rgba(${r},${g},${b},0.3)`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0.5)`);
        sparklineChart.data.datasets[1].backgroundColor = gradient;
        sparklineChart.update();
      }

      sparklineChart.options.scales.x.min = sevenAM;
      sparklineChart.options.scales.x.max = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19,0,0).getTime();
      sparklineChart.options.scales.y.max = systemCapacityKwp || undefined;
      sparklineChart.options.scales.x.ticks.color = isDark ? '#f8fafc' : '#0f172a';
      sparklineChart.options.scales.y.ticks.color = isDark ? '#f8fafc' : '#0f172a';
      sparklineChart.options.plugins.legend.labels.color = isDark ? '#f8fafc' : '#0f172a';
      sparklineChart.update();
    }
  } catch (e) {
    console.error('Forecast error:', e);
    banner.style.display = 'none';
  }
}

function setWeatherIconColor(iconEl, desc) {
  const descLower = (desc || '').toLowerCase();
  if (descLower.includes('clear') || descLower.includes('sunny')) iconEl.style.color = '#f59e0b';
  else if (descLower.includes('partly cloudy')) iconEl.style.color = '#eab308';
  else if (descLower.includes('cloudy') || descLower.includes('overcast')) iconEl.style.color = '#9ca3af';
  else if (descLower.includes('rain') || descLower.includes('drizzle')) iconEl.style.color = '#3b82f6';
  else if (descLower.includes('fog')) iconEl.style.color = '#94a3b8';
  else iconEl.style.color = 'var(--text)';
}

function getDayName(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}

function formatHoursToHM(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h.toString().padStart(2, '0')}h:${m.toString().padStart(2, '0')}m`;
}

async function loadBranding() {
  try {
    const res = await fetch('/api/public-config');
    const cfg = await res.json();
    if (cfg.dashboard_title) {
      document.getElementById('dashboard-title').textContent = cfg.dashboard_title;
      document.title = cfg.dashboard_title;
    }
    if (cfg.dashboard_logo) {
      document.getElementById('logo-img').src = cfg.dashboard_logo;
      document.getElementById('logo-img').style.display = 'inline';
    }
    if (cfg.solar_capacity_kwp) systemCapacityKwp = parseFloat(cfg.solar_capacity_kwp) || 2.1;
  } catch (e) {}
}

async function updateAllComponents() {
  const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
  if (!activeLayout) return;

  if (activeLayout.some(b => b.type === 'flow-card')) updateFlowCard();
  if (activeLayout.some(b => b.type === 'forecast-banner')) updateForecast();
  if (activeLayout.some(b => b.type === 'metric-cards')) updateMetricCards();
  if (activeLayout.some(b => b.type === 'grid-card')) updateGridCard();
  if (activeLayout.some(b => b.type === 'chart-power')) updatePowerChart(1);
  if (activeLayout.some(b => b.type === 'chart-energy')) updateEnergyChart();
  if (activeLayout.some(b => b.type === 'savings-summary')) updateSavings();
  if (activeLayout.some(b => b.type === 'data-table-daily')) updateDailyTable();
  if (activeLayout.some(b => b.type === 'data-table-monthly')) updateMonthlyTable();

  // Forecast is already conditionally called above
}

// ─── Init ──────────────────────────────────────────────────────────────────
initTheme();
loadDashboardConfig().then(() => {
  setInterval(updateAllComponents, 30000);
});

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
