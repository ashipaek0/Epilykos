/**
 * Dashboard tabs: which tabs a visitor sees, where the bar sits, and whether it is folded away.
 *
 * Everyone sees the dashboards' tabs; the Controls page is a tab only for a signed-in session, so a
 * visitor never sees it (the server refuses the page without a session as well). Pure helpers, so the
 * rules are testable; public/js/dashboard.js draws the bar.
 *
 * Settings → Appearance can switch tabs off ('off'): the old behaviour. Visitors then see no tabs at all; a
 * signed-in admin always has the bar (with Controls and Edit layout), as before tabs were shown to everyone.
 */

export const TAB_POSITIONS = ['top', 'left', 'right', 'off'];
const COLLAPSED_KEY = 'epilykos_tabs_collapsed';

/** The stored setting, or 'top' for anything unknown. */
export function tabsPosition(value) {
  return TAB_POSITIONS.includes(value) ? value : 'top';
}

/** Phones always get the bar along the top, where a side bar would crowd the cards out. 'off' stays off. */
export function effectivePosition(value, width) {
  if (value === 'off') return 'off';
  return width < 768 ? 'top' : tabsPosition(value);
}

/**
 * The tabs to draw, in order: one per dashboard, then (signed in only) Controls, which opens its own page.
 * A bar is worth drawing for a visitor only when there is more than one dashboard to choose from.
 * With tabs off, only a signed-in admin has a bar (it still holds Controls); visitors have none.
 */
export function tabsFor(dashboards, signedIn, off = false) {
  const tabs = (dashboards || []).map(d => ({ kind: 'dashboard', id: d.id, label: d.name }));
  if (signedIn) tabs.push({ kind: 'page', id: 'controls', label: 'Controls', href: '/controls' });
  return { tabs, show: off ? !!signedIn : (signedIn || tabs.length > 1) };
}

/** Folded away by this browser's owner (kept per browser, not shared). */
export function readCollapsed(storage) {
  try { return (storage || localStorage).getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}
export function writeCollapsed(collapsed, storage) {
  try { (storage || localStorage).setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* private window */ }
}
