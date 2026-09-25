export function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const toggle = document.getElementById('theme-toggle');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
  }
  if (toggle) {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    toggle.innerHTML = currentTheme === 'dark'
      ? '<span class="theme-icon">☀</span>'
      : '<span class="theme-icon">☾</span>';
  }
}

function dispatchThemeEvent() {
  document.body.dispatchEvent(new CustomEvent('theme-changed'));
}

export function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  const toggle = document.getElementById('theme-toggle');
  if (toggle) toggle.innerHTML = newTheme === 'dark' ? '<span class="theme-icon">☀</span>' : '<span class="theme-icon">☾</span>';
  dispatchThemeEvent();
  updateChartColors();
  import('./forecast.js').then(m => m.updateForecast());
}

// This function will be called from toggleTheme
export function updateChartColors() {
  import('./charts.js').then(module => module.updateChartColors());
}
