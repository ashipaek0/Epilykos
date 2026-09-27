import { componentBuilders } from './components/index.js';
import { getFamily, resolveBinding, familyNames } from './dashboard-family-contract.mjs';
import { mergePersistedBlock } from './dashboard-config-roundtrip.mjs';

const FAMILY_TYPES = Object.freeze(Object.fromEntries(familyNames.map(name => [name, getFamily(name).componentType])));
export function resolveFamilyComponentType(type) { return FAMILY_TYPES[type] || type; }
export function expandFamilyBlockTypes(iterable) {
  const expanded = new Set(iterable);
  for (const type of expanded) expanded.add(resolveFamilyComponentType(type));
  return expanded;
}

export function resolveDashboardFamily(name) {
  const family = getFamily(name);
  if (!family) throw new TypeError(`Unknown dashboard family: ${name}`);
  const builder = componentBuilders[family.componentType];
  if (typeof builder !== 'function') throw new TypeError(`Missing builder for ${name}`);
  return Object.freeze({
    ...family,
    builder,
    update(binding, values) {
      const result = resolveBinding(binding, values);
      return result.status === 'data' ? result.value : null;
    },
    persist(existing, geometry) { return mergePersistedBlock(existing, geometry); },
    settings(block) { return JSON.parse(JSON.stringify(block?.config && typeof block.config === 'object' ? block.config : {})); }
  });
}
