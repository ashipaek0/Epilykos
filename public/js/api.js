export async function fetchDashboardState() {
  const res = await fetch('/api/dashboard-state');
  return res.json();
}

export async function fetchPublicConfig() {
  const res = await fetch('/api/public-config');
  return res.json();
}

export async function fetchDashboardConfig() {
  const res = await fetch('/api/dashboard-config');
  return res.json();
}

export async function saveDashboardConfig(config) {
  await fetch('/api/dashboard-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
}
