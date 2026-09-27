export function normalizeSegmentedGauge(config={}) {
  return {...config, min:config.min ?? 0, max:config.max ?? 100, segments:config.segments ?? 30, spacing:config.spacing ?? 0.3, thresholds:Array.isArray(config.thresholds) ? config.thresholds.map(t=>({...t})) : [], markers:config.markers ?? true, labels:config.labels ?? false, endpoint:config.endpoint ?? 'point', sparkline:config.sparkline ?? 'area', reducer:config.reducer ?? 'lastNotNull'};
}
export function segmentedGaugeColor(value, thresholds=[]) {
  let color = null;
  for (const threshold of thresholds) if (Number.isFinite(threshold?.value) && value >= threshold.value) color = threshold.color;
  return color;
}
export function segmentedGaugeSegmentColors(min, max, segments, thresholds=[]) {
  return Array.from({length:Math.max(0,segments)}, (_,i) => segmentedGaugeColor(min + ((i + 1) / segments) * (max - min), thresholds));
}
