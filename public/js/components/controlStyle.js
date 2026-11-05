/**
 * Look of the control cards (Button, Toggle, Slider, Knob, State select), set per card in the
 * layout editor. Every option is optional; a card with none of them looks as it always did.
 *
 *   layout     Button: centered (default), tile, compact, row.   Toggle: classic (default), tile,
 *              compact, row.   Slider, Knob, State select: classic (default), tile.
 *                tile     name and sub-label top left, the icon (or a picture) large on the right,
 *                         the toggle pill bottom right
 *                compact  a small icon over the name, for rows of quick actions
 *                row      icon at the left, name and sub-label beside it, toggle pill at the right
 *   sublabel   a second line under the name, such as the room
 *   pill       the on/off pill on a Button card (Toggle cards always have their switch)
 *   fill       tint the card with its "on" colour while it is on
 *   group      which filter chip on the Controls page the card belongs to
 *
 * @module components/controlStyle
 */
import { escapeHtml } from '../utils.js';

export const LAYOUTS = {
  'button-card': ['centered', 'tile', 'compact', 'row'],
  'switch-block': ['classic', 'tile', 'compact', 'row'],
  numctl: ['classic', 'tile'],
  'state-select': ['classic', 'tile']
};
export const DEFAULT_LAYOUT = { 'button-card': 'centered', 'switch-block': 'classic', numctl: 'classic', 'state-select': 'classic' };
export const LAYOUT_LABELS = {
  centered: 'Centered (icon, name, state)', classic: 'Classic', tile: 'Tile (name and room, large icon, toggle pill)',
  compact: 'Compact (small icon over the name, for quick actions)', row: 'Row (icon, name, toggle pill)'
};

/** Whether a layout shows the on/off pill by default. */
export const layoutHasPill = layout => layout === 'tile' || layout === 'row';

/** The style options of a card's config, with every value checked. */
export function controlStyle(config = {}, kind = 'button-card') {
  const allowed = LAYOUTS[kind] || ['classic'];
  const layout = allowed.includes(config.layout) ? config.layout : DEFAULT_LAYOUT[kind] || 'classic';
  const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    layout,
    sublabel: text(config.sublabel, 40),
    pill: config.pill === undefined ? layoutHasPill(layout) : config.pill === true,
    fill: config.fill === true,
    group: text(config.group, 24)
  };
}

/** The filter-chip group a card's config names ('' when none). */
export const groupOf = config => String((config && config.group) || '').replace(/\s+/g, ' ').trim().slice(0, 24);

/** Chips for a list of blocks: the distinct groups in order, plus "Other" when some cards have none. [] when no card has a group. */
export function filterChips(blocks) {
  const groups = [];
  let ungrouped = false;
  for (const b of blocks || []) {
    const g = groupOf(b && b.config);
    if (!g) ungrouped = true; else if (!groups.includes(g)) groups.push(g);
  }
  if (!groups.length) return [];
  return ungrouped ? [...groups, ''] : groups;
}

/** Whether a block shows under a filter: null is "All"; '' is the cards with no group. */
export const matchesFilter = (block, filter) => filter == null || groupOf(block && block.config) === filter;

/** Classes for the card element: cs-<layout> and cs-fill. The default layout adds none, so existing cards do not change. */
export function styleClasses(style, kind) {
  const out = [];
  if (style.layout !== DEFAULT_LAYOUT[kind]) out.push('cs', `cs-${style.layout}`);
  if (style.fill) out.push('cs', 'cs-fill');
  return [...new Set(out)].join(' ');
}

export const subLabelHtml = (style, cls) => (style.sublabel ? `<span class="${cls}">${escapeHtml(style.sublabel)}</span>` : '');
