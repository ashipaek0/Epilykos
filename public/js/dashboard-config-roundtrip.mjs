export function normalizeDashboardConfig(config) {
  return config == null ? config : JSON.parse(JSON.stringify(config));
}
export function serializeDashboardConfig(config) {
  return JSON.stringify(normalizeDashboardConfig(config));
}
export function deserializeDashboardConfig(payload) {
  return normalizeDashboardConfig(typeof payload === 'string' ? JSON.parse(payload) : payload);
}

export function roundTripConfig(block) {
  return block == null ? block : JSON.parse(JSON.stringify(block));
}
export function mergePersistedBlock(existing, geometry) {
  const block = existing ? JSON.parse(JSON.stringify(existing)) : {};
  return Object.assign(block, geometry);
}
