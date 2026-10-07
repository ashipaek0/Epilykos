/**
 * Tabbed energy card: several of the hourly energy cards in one place, one
 * tab each (for example Energy, Flows, Costs), like Victron's Dynamic ESS card.
 *
 * Only cards that fetch and refresh their own data can go in a tab; cards
 * fed by the dashboard's live updates would not receive them inside a tab.
 * A tab's card is built the first time the tab is opened, so hidden tabs do
 * not fetch anything. The last tab opened is remembered on this device.
 *
 * @module components/energyTabs
 */
import { escapeHtml } from '../utils.js';
import { buildEnergyDay } from './energyDay.js';
import { buildEnergyFlows } from './energyFlows.js';
import { buildEnergyCosts } from './energyCosts.js';
import { buildEnergyTotals } from './energyTotals.js';

export const TAB_CARDS = {
  'energy-day': { name: 'Energy day', label: 'Energy', build: buildEnergyDay },
  'energy-flows': { name: 'Energy flows', label: 'Flows', build: buildEnergyFlows },
  'energy-costs': { name: 'Costs and earnings', label: 'Costs and earnings', build: buildEnergyCosts },
  'energy-totals': { name: 'Day totals', label: 'Totals', build: buildEnergyTotals }
};
export const DEFAULT_TABS = [{ type: 'energy-day' }, { type: 'energy-flows' }, { type: 'energy-costs' }];

let sequence = 0;
const storeKey = id => `epilykos.energyTabs.${id}`;
function remembered(id) { try { return Number(localStorage.getItem(storeKey(id))); } catch (_) { return NaN; } }
function remember(id, i) { try { localStorage.setItem(storeKey(id), String(i)); } catch (_) { /* private mode */ } }

export function buildEnergyTabs(block = {}) {
  const config = block.config || {};
  const tabs = (Array.isArray(config.tabs) && config.tabs.length ? config.tabs : DEFAULT_TABS).filter(t => t && TAB_CARDS[t.type]).slice(0, 4);
  const card = document.createElement('div');
  card.className = 'energy-tabs-card';
  card.dataset.blockId = block.id || '';
  const uid = `etabs-${++sequence}`;
  card.innerHTML = (config.title ? `<h3 class="etabs-title">${escapeHtml(config.title)}</h3>` : '') +
    `<div class="etabs-list" role="tablist" aria-label="${escapeHtml(config.title || 'Energy')}">${tabs.map((t, i) =>
      `<button type="button" role="tab" class="etabs-tab" id="${uid}-tab-${i}" aria-controls="${uid}-panel-${i}" aria-selected="false" tabindex="-1">${escapeHtml(t.label || TAB_CARDS[t.type].label)}</button>`).join('')}</div>` +
    tabs.map((t, i) => `<div class="etabs-panel" role="tabpanel" id="${uid}-panel-${i}" aria-labelledby="${uid}-tab-${i}" hidden></div>`).join('');

  const buttons = [...card.querySelectorAll('.etabs-tab')], panels = [...card.querySelectorAll('.etabs-panel')];
  const show = (i, focus) => {
    buttons.forEach((b, k) => { b.setAttribute('aria-selected', String(k === i)); b.tabIndex = k === i ? 0 : -1; });
    panels.forEach((p, k) => { p.hidden = k !== i; });
    const panel = panels[i];
    if (!panel.firstChild) {
      const t = tabs[i];
      panel.appendChild(TAB_CARDS[t.type].build({ id: `${block.id || 'tabs'}-tab${i}`, type: t.type, config: { ...(t.config || {}), hideTitle: true } }));
    }
    // The card's own controls (day buttons, Hide forecast) line up with the tab bar.
    card.style.setProperty('--etabs-row-top', `${card.querySelector('.etabs-list').offsetTop}px`);
    if (focus) buttons[i].focus();
    remember(block.id || '', i);
  };
  buttons.forEach((b, i) => b.addEventListener('click', () => show(i)));
  card.querySelector('.etabs-list').addEventListener('keydown', e => {
    const i = buttons.indexOf(document.activeElement); if (i < 0) return;
    const next = { ArrowRight: (i + 1) % buttons.length, ArrowLeft: (i - 1 + buttons.length) % buttons.length, Home: 0, End: buttons.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault(); show(next, true);
  });
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (!card.isConnected) ro.disconnect(); else card.style.setProperty('--etabs-row-top', `${card.querySelector('.etabs-list').offsetTop}px`); });
    requestAnimationFrame(() => ro.observe(card));
  }
  if (tabs.length) {
    const start = remembered(block.id || '');
    show(Number.isInteger(start) && start >= 0 && start < tabs.length ? start : 0);
  }
  return card;
}
