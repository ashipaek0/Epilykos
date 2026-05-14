const { getConfig, setConfig } = require('./database');

const DEFAULT_CONFIG = {
  dashboards: [
    {
      id: 'main',
      name: 'Main',
      layout: [
        { type: 'flow-card' },
        { type: 'forecast-banner' },
        { type: 'metric-cards', cards: [
          { id: 'daily_solar', title: "Today's Solar", metric: 'daily_solar', unit: 'kWh' },
          { id: 'daily_consumption', title: "Today's Usage", metric: 'daily_consumption', unit: 'kWh' },
          { id: 'daily_grid_import', title: "Today's Grid", metric: 'daily_grid_import', unit: 'kWh' },
          { id: 'battery_voltage', title: 'Battery Voltage', metric: 'battery_voltage', unit: 'V' },
          { id: 'inverter_temp', title: 'Inverter Temp', metric: 'inverter_temp', unit: '°C' },
          { id: 'solar_voltage', title: 'Solar Voltage', metric: 'solar_voltage', unit: 'V' }
        ]},
        { type: 'savings-summary' },
        { type: 'grid-card' },
        { type: 'chart-power' },
        { type: 'chart-energy' },
        { type: 'data-table-daily' },
        { type: 'data-table-monthly' }
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
