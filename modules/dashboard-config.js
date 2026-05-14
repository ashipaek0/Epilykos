const { getConfig, setConfig } = require('./database');
const { logger } = require('./logger');

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

// Helper to assign default grid properties based on block type
function getDefaultDimensions(type) {
  switch (type) {
    case 'chart-power':
    case 'chart-energy':
    case 'data-table-daily':
    case 'data-table-monthly':
    case 'forecast-banner':
    case 'grid-card':
      return { w: 12, h: 6 };
    case 'metric-cards':
      return { w: 12, h: 4 };
    case 'flow-card':
    case 'savings-summary':
      return { w: 12, h: 3 };
    default:
      return { w: 6, h: 4 };
  }
}

function migrateLayout(layout) {
  let x = 0;
  let y = 0;
  return layout.map((block, idx) => {
    // If block already has grid props, preserve them
    if (block.x !== undefined && block.y !== undefined && block.w !== undefined && block.h !== undefined) {
      // Update x,y for next block based on current block's y + h
      if (block.x + block.w >= 12) {
        x = 0;
        y = block.y + block.h;
      } else {
        x = block.x + block.w;
        y = block.y;
      }
      return block;
    }
    // Assign default dimensions
    const dims = getDefaultDimensions(block.type);
    const newBlock = {
      ...block,
      x: x,
      y: y,
      w: dims.w,
      h: dims.h,
      minW: 2,
      minH: 2
    };
    // Update x,y for next block
    if (x + dims.w >= 12) {
      x = 0;
      y = y + dims.h;
    } else {
      x = x + dims.w;
    }
    return newBlock;
  });
}

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
    // Migrate each dashboard's layout to include grid properties
    let changed = false;
    parsed.dashboards.forEach(dashboard => {
      const needsMigration = dashboard.layout.some(block => block.x === undefined);
      if (needsMigration) {
        dashboard.layout = migrateLayout(dashboard.layout);
        changed = true;
      }
    });
    if (changed) {
      setConfig('dashboard_config', JSON.stringify(parsed));
      logger.info('Migrated dashboard layout to include grid properties');
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
