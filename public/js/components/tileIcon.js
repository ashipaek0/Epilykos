/**
 * An optional icon or image on a value tile: Metric cards, Multi-value list rows and the Text metric card.
 *
 * The setting is the same as the Button card's icon: "mdi:solar-power" (a name from buttonIcons.js), an image
 * address or path ("https://…", "/uploads/panel.png"), or an emoji. Empty = no icon, and the tile is exactly as
 * it was. With one, the tile puts a rounded square holding it beside the label and value (cards.css), sized from
 * the card so it follows the card when it is resized.
 *
 * Built with the DOM, never innerHTML with the setting in it: an image address is set on the element, an emoji
 * is text, and an icon name only selects built-in path data.
 *
 * @module components/tileIcon
 */
import { mdiSvg } from './buttonIcons.js';

/** The icon element for a setting, or null when there is none. */
export function tileIcon(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  const el = document.createElement('span');
  el.className = 'tile-icon';
  el.setAttribute('aria-hidden', 'true');
  const svg = mdiSvg(v);
  if (svg) {
    el.innerHTML = svg;   // built-in path data selected by name, never the setting's text
  } else if (/^(https?:)?\/\//i.test(v) || v.startsWith('/')) {
    el.classList.add('is-image');
    const img = document.createElement('img');
    img.alt = ''; img.draggable = false; img.loading = 'lazy';
    // An address that does not load leaves no empty frame: the icon goes and the tile is as it was without one.
    img.addEventListener('error', () => {
      const tile = el.parentNode;
      el.remove();
      if (tile && !tile.querySelector(':scope > .tile-icon')) tile.classList.remove('has-icon');
    });
    img.src = v;
    el.appendChild(img);
  } else {
    el.classList.add('is-emoji');
    el.textContent = v.slice(0, 4);
  }
  return el;
}

/** Put the icon for `value` first in a tile. Returns whether there was one. */
export function applyTileIcon(tile, value) {
  const icon = tileIcon(value);
  if (!icon || !tile) return false;
  tile.classList.add('has-icon');
  tile.insertBefore(icon, tile.firstChild);
  return true;
}
