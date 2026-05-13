import { initTheme, toggleTheme } from './theme.js';
import { loadDashboardConfig } from './dashboard.js';
import { updateAllComponents } from './updater.js';

initTheme();
await loadDashboardConfig();
setInterval(updateAllComponents, 30000);
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
