export function listDashboardPresets(template) {
  return (template?.dashboards || []).flatMap(dashboard => (dashboard.layout || []).map(panel => ({
    dashboardId: dashboard.id,
    ...JSON.parse(JSON.stringify(panel))
  })));
}

export function createPresetBlock(preset, makeId) {
  const block = JSON.parse(JSON.stringify(preset));
  block.id = makeId();
  block.panelId = preset.panelId || preset.id;
  block.sourcePanelId = preset.panelId || preset.id;
  return block;
}

export function previewTemplateImport(imported) {
  const dashboards = imported?.dashboards || [];
  const cards = dashboards.flatMap(d => d.layout || []);
  const breakdown = {};
  for (const card of cards) breakdown[card.type] = (breakdown[card.type] || 0) + 1;
  return { dashboardCount: dashboards.length, cardCount: cards.length, familyBreakdown: breakdown };
}

export function applyTemplateImport(current, imported, action, makeId) {
  if (!['append', 'replace'].includes(action)) return null;
  const clone = value => JSON.parse(JSON.stringify(value));
  let result = action === 'replace' ? clone(imported) : clone(current);
  if (action === 'append') {
    const used = new Set(result.dashboards.flatMap(d => [d.id, ...(d.layout || []).map(c => c.id)]));
    const unique = id => { let candidate = id, suffix = 1; while (used.has(candidate)) candidate = `${id}-${suffix++}`; used.add(candidate); return candidate; };
    result.dashboards.push(...clone(imported.dashboards).map(d => {
      d.id = unique(d.id);
      d.layout = (d.layout || []).map(card => { card.id = unique(card.id); return card; });
      return d;
    }));
  }
  return result;
}
