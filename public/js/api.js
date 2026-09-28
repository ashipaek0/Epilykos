import { serializeDashboardConfig, deserializeDashboardConfig } from './dashboard-config-roundtrip.mjs';

async function fetchJson(endpoint) {
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error(`API request failed: ${endpoint} (${res.status})`);
  const contentType = res.headers?.get('content-type') || '';
  if (!/^application\/json\b/i.test(contentType)) {
    throw new Error(`Invalid API response: ${endpoint} (${res.status})`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`Invalid API response: ${endpoint} (${res.status})`);
  }
}

export async function fetchDashboardState() {
  return fetchJson('/api/dashboard-state');
}

export async function fetchPublicConfig() {
  return fetchJson('/api/public-config');
}

export async function fetchDashboardConfig() {
  const res = await fetch('/api/dashboard-config');
  return deserializeDashboardConfig(await res.text());
}

export async function saveDashboardConfig(config) {
  const res = await fetch('/api/dashboard-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: serializeDashboardConfig(config)
  });
  if (!res.ok) {
    let msg = `Save failed (${res.status})`;
    try { const err = await res.json(); if (err.error) msg = err.error + ` (${res.status})`; } catch (e) {}
    throw new Error(msg);
  }
}
