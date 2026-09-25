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
  const res = await fetch('/api/dashboard-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(config)
  });
  if (!res.ok) {
    let msg = `Save failed (${res.status})`;
    try { const err = await res.json(); if (err.error) msg = err.error + ` (${res.status})`; } catch (e) {}
    throw new Error(msg);
  }
}
