export function buildBatteryBlock(block = {}) {
  const config = block.config || {};
  const metrics = config.metrics || {
    soc: 'battery_soc',
    voltage: 'battery_voltage',
    current: 'battery_current',
    power: 'battery_power',
    temperature: 'battery_temp'
  };

  const container = document.createElement('div');
  container.className = 'battery-block card';
  container.style.background = 'var(--card-bg)';
  container.style.borderRadius = 'var(--radius)';
  container.style.padding = '1rem';
  container.style.boxShadow = 'var(--shadow)';
  container.style.border = '1px solid var(--border)';
  container.dataset.metricMap = JSON.stringify(metrics);

  container.innerHTML = `
    <div class="battery-block-header" style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
      <h3 style="margin:0;">${escapeHtml(config.title || 'Battery')}</h3>
    </div>
    <div class="battery-soc-display" style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem;">
      <div class="battery-soc-big" data-metric="${escapeHtml(metrics.soc)}" style="font-size: 2rem; font-weight: bold;">--%</div>
      <div class="battery-soc-bar" style="flex:1; height: 1rem; background: var(--border); border-radius: 0.5rem; overflow: hidden;">
        <div class="battery-soc-fill" style="width:0%; height:100%; background: var(--battery); transition: width 0.3s;"></div>
      </div>
    </div>
    <div class="battery-details" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; font-size: 0.85rem;">
      <div>Voltage: <span data-metric="${escapeHtml(metrics.voltage)}">-- V</span></div>
      <div>Current: <span data-metric="${escapeHtml(metrics.current)}">-- A</span></div>
      <div>Power: <span data-metric="${escapeHtml(metrics.power)}">-- W</span></div>
      <div>Temperature: <span data-metric="${escapeHtml(metrics.temperature)}">-- °C</span></div>
    </div>
  `;
  return container;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function updateBatteryBlock(state) {
  const container = document.querySelector('.battery-block');
  if (!container) return;

  let metricsMap;
  try {
    metricsMap = JSON.parse(container.dataset.metricMap);
  } catch (e) {
    return;
  }

  const metrics = state.metrics || {};

  const updateMetric = (role, selector, format) => {
    const metricName = metricsMap[role];
    if (!metricName) return;
    const val = metrics[metricName]?.value;
    if (val === undefined || val === null) return;
    const el = container.querySelector(selector);
    if (el) el.textContent = format(val);
  };

  updateMetric('soc', '.battery-soc-big', (v) => `${Math.round(v)}%`);
  updateMetric('voltage', `[data-metric="${metricsMap.voltage}"]`, (v) => v.toFixed(1) + ' V');
  updateMetric('current', `[data-metric="${metricsMap.current}"]`, (v) => v.toFixed(1) + ' A');
  updateMetric('power', `[data-metric="${metricsMap.power}"]`, (v) => Math.round(v) + ' W');
  updateMetric('temperature', `[data-metric="${metricsMap.temperature}"]`, (v) => v.toFixed(1) + ' °C');

  // SOC bar fill
  const socMetricName = metricsMap.soc;
  if (socMetricName) {
    const socVal = metrics[socMetricName]?.value;
    if (socVal !== undefined && socVal !== null) {
      const fill = container.querySelector('.battery-soc-fill');
      if (fill) fill.style.width = `${Math.min(100, Math.max(0, socVal))}%`;
    }
  }
}
