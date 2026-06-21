const { logger } = require('./logger');
const { getConfig, setConfig } = require('./database');

const DEFAULT_CONFIG = {
  dashboards: [
    {
      id: 'main',
      name: 'Default',
      layout: [
        { id: 'b_flow2', type: 'flow-card-2', gridX: 0, gridY: 0, gridW: 4, gridH: 12, enabled: true, transparent: false, bgColor: '#0f172a', innerBgColor: '#0f172a', config: { title: ' ', inverter_image: 'https://i.postimg.cc/0y66sKCR/srne.png', metrics: { solar: 'PV Power', grid: 'Grid Power', consumption: 'Load Power', battery_power: 'Battery Charge Power', battery_discharge: 'Battery Discharge Power', battery_soc: 'Battery SOC' } } },
        { id: 'b_forecast', type: 'forecast-pvtoday', gridX: 4, gridY: 0, gridW: 8, gridH: 7, enabled: true, transparent: false, bgColor: '#0f172a', innerBgColor: '#0f172a', config: { location_name: '', metrics: { generated: 'PV Power' } } },
        { id: 'b_grid', type: 'grid-card', gridX: 4, gridY: 7, gridW: 8, gridH: 5, enabled: true, transparent: false, bgColor: '#0f172a', innerBgColor: '#0f172a', config: { showTimeline: true, metrics: { grid_status: 'Grid Status' } } },
        { id: 'b_bars', type: 'bar-gauge', gridX: 0, gridY: 12, gridW: 4, gridH: 4, enabled: true, transparent: false, bgColor: '#0f172a', innerBgColor: '#0f172a', fontSize: '0.85rem', config: { metrics: [{ label: 'Solar', metric: 'PV Energy Generated', unit: 'kWh', min: 0, max: 15, color: '#0f172a', gradient: '#FFEA00' }, { label: 'Grid', metric: 'Grid Energy Import', unit: 'kWh', min: 0, max: 15, color: '#0f172a', gradient: '#FF4255' }, { label: 'Batt', metric: 'Battery Energy (Discharge)', unit: 'kWh', min: 0, max: 13, color: '#000000', gradient: '#00E056 ' }, { label: 'Load', metric: 'Load Energy Consumed', unit: 'kWh', min: 0, max: 15, color: '#000000', gradient: '#0062FF' }] } },
        { id: 'b_savings', type: 'savings-summary', gridX: 4, gridY: 12, gridW: 3, gridH: 4, enabled: true, transparent: false, bgColor: '#0f172a', innerBgColor: '#0f172a', config: { title: ' ', showToday: true, showWeek: true, showMonth: true, showAll: true, savings_metric: 'PV Energy Generated' } },
        { id: 'b_mv1', type: 'multi-value', gridX: 7, gridY: 12, gridW: 5, gridH: 2, enabled: true, bgColor: '#0f172a', innerBgColor: '#0f172a', config: { metrics: [{ label: 'PV Voltage', metric: 'PV Voltage', unit: 'V' }, { label: 'PV Current', metric: 'PV Current', unit: 'V' }, { label: 'Peak PV', metric: 'Peak PV Power', unit: '' }] } },
        { id: 'b_mv2', type: 'multi-value', gridX: 7, gridY: 14, gridW: 5, gridH: 2, enabled: true, bgColor: '#0f172a', innerBgColor: '#0f172a', config: { metrics: [{ label: 'Batt Voltage', metric: 'Battery Voltage', unit: 'V' }, { label: 'Batt Current', metric: 'Battery Current', unit: 'A' }, { label: 'Batt Runtime', metric: 'Battery Runtime', unit: 'h' }] } },
        { id: 'b_energy', type: 'chart-energy', gridX: 0, gridY: 16, gridW: 12, gridH: 10, enabled: true, transparent: false, bgColor: '#0f172a', innerBgColor: '#0f172a', config: { title: ' ', datasets: [{ label: 'Solar Generated', metric: 'PV Energy Generated', color: '#ffea00' }, { label: 'Grid Imported', metric: 'Grid Energy Import', color: '#ff4255' }, { label: 'Energy Consumed', metric: 'Load Energy Consumed', color: '#0062ff' }] } },
        { id: 'b_daily', type: 'data-table-daily', gridX: 0, gridY: 26, gridW: 12, gridH: 8, enabled: true, bgColor: '#0f172a', innerBgColor: '#0f172a', config: {} },
        { id: 'b_monthly', type: 'data-table-monthly', gridX: 0, gridY: 34, gridW: 12, gridH: 8, enabled: true, bgColor: '#0f172a', innerBgColor: '#0f172a', config: {} }
      ]
    }
  ],
  activeDashboard: 'main'
};

function getDashboardConfig() {
  try {
    let configStr = getConfig('dashboard_config');
    if (!configStr || configStr.trim() === '' || configStr === 'null') {
      setConfig('dashboard_config', JSON.stringify(DEFAULT_CONFIG));
      return DEFAULT_CONFIG;
    }
    const parsed = JSON.parse(configStr);
    if (!parsed.dashboards || !Array.isArray(parsed.dashboards) || parsed.dashboards.length === 0) {
      throw new Error('Invalid dashboard config structure');
    }
    return parsed;
  } catch (err) {
    logger.error('Error parsing dashboard config, using default:', err.message);
    setConfig('dashboard_config', JSON.stringify(DEFAULT_CONFIG));
    return DEFAULT_CONFIG;
  }
}

function saveDashboardConfig(config) {
  setConfig('dashboard_config', JSON.stringify(config));
}

module.exports = { getDashboardConfig, saveDashboardConfig };
