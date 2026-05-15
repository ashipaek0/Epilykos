export function buildBatteryBlock(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'battery-block card';
  container.style.background = 'var(--card-bg)';
  container.style.borderRadius = 'var(--radius)';
  container.style.padding = '1rem';
  container.style.boxShadow = 'var(--shadow)';
  container.style.border = '1px solid var(--border)';
  
  container.innerHTML = `
    <div class="battery-block-header" style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
      <h3 style="margin:0;">${escapeHtml(config.title || 'Battery')}</h3>
    </div>
    <div class="battery-soc-display" style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem;">
      <div class="battery-soc-big" style="font-size: 2rem; font-weight: bold;">--%</div>
      <div class="battery-soc-bar" style="flex:1; height: 1rem; background: var(--border); border-radius: 0.5rem; overflow: hidden;">
        <div class="battery-soc-fill" style="width:0%; height:100%; background: var(--battery); transition: width 0.3s;"></div>
      </div>
    </div>
    <div class="battery-details" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; font-size: 0.85rem;">
      <div>Voltage: <span class="battery-voltage">-- V</span></div>
      <div>Current: <span class="battery-current">-- A</span></div>
      <div>Power: <span class="battery-power">-- W</span></div>
      <div>Temperature: <span class="battery-temp">-- °C</span></div>
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
  const metrics = state.metrics || {};
  
  const soc = metrics.battery_soc?.value;
  const voltage = metrics.battery_voltage?.value;
  const current = metrics.battery_current?.value;
  const power = metrics.battery_power?.value;
  const temp = metrics.battery_temp?.value;
  
  if (soc !== undefined) {
    container.querySelector('.battery-soc-big').textContent = `${Math.round(soc)}%`;
    container.querySelector('.battery-soc-fill').style.width = `${Math.min(100, Math.max(0, soc))}%`;
  }
  if (voltage !== undefined) container.querySelector('.battery-voltage').textContent = voltage.toFixed(1);
  if (current !== undefined) container.querySelector('.battery-current').textContent = current.toFixed(1);
  if (power !== undefined) container.querySelector('.battery-power').textContent = Math.round(power);
  if (temp !== undefined) container.querySelector('.battery-temp').textContent = temp.toFixed(1);
}
