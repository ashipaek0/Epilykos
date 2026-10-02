/**
 * A block's Style settings (background, text colour, text size, transparent)
 * applied to its rendered card. Shared by the dashboard and the layout
 * editor's previews so both look the same.
 *
 * Text size: card styles size text in rem and container units, which don't
 * inherit a font-size set on the card. Every card font-size is therefore
 * written as calc(<size> * var(--card-font-scale, 1)) in style.css and
 * cards.css, and this sets --card-font-scale on the card.
 *
 * Text colour: values and labels set their own colour from --text and
 * --text-secondary, so those are overridden on the card too.
 *
 * @module components/blockStyle
 */

/**
 * Text size setting → scale factor, or null for the default size.
 * Accepts what the editor saves ("115%") and older free-text values
 * ("1.2rem", "1.2em", "18px", "1.2").
 */
export function fontScale(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d*\.?\d+)\s*(%|rem|em|px)?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = m[2] || '';
  if (unit === '%') n /= 100;
  else if (unit === 'px' || (!unit && n > 4)) n /= 16;
  if (!Number.isFinite(n) || n <= 0) return null;
  n = Math.min(3, Math.max(0.5, n));
  return Math.abs(n - 1) < 0.001 ? null : Math.round(n * 1000) / 1000;
}

const DEFAULT_BG = '#ffffff';
const DEFAULT_TEXT = '#000000';

/** Apply `block`'s Style settings to its card element. */
export function applyBlockStyle(content, block) {
  if (!content || !block) return;
  if (block.bgColor && block.bgColor !== DEFAULT_BG) {
    content.style.setProperty('background-color', block.bgColor, 'important');
  }
  if (block.innerBgColor && block.innerBgColor !== DEFAULT_BG) {
    content.style.setProperty('--card-bg', block.innerBgColor, 'important');
    content.style.setProperty('--bg', block.innerBgColor, 'important');
  }
  if (block.fontColor && block.fontColor !== DEFAULT_TEXT) {
    content.style.setProperty('color', block.fontColor, 'important');
    content.style.setProperty('--text', block.fontColor);
    content.style.setProperty('--text-primary', block.fontColor);
    content.style.setProperty('--text-secondary', `color-mix(in srgb, ${block.fontColor} 72%, transparent)`);
  }
  const scale = fontScale(block.fontSize);
  if (scale) content.style.setProperty('--card-font-scale', String(scale));
  if (block.transparent) {
    content.style.background = 'transparent';
    content.style.borderColor = 'transparent';
    content.style.boxShadow = 'none';
    // Children using var(--card-bg) / var(--bg) become transparent too.
    content.style.setProperty('--card-bg', 'transparent');
    content.style.setProperty('--bg', 'transparent');
    content.querySelectorAll('.stat-card, .topo-node-circle, .chart-container, .fcs-inverter-icon, .fcs2-inv').forEach(el => {
      el.style.background = 'transparent';
      el.style.borderColor = 'transparent';
      el.style.boxShadow = 'none';
    });
    // .topo-hub carries the inverter image via background-image (inline, from
    // config): clear backgroundColor only so the shorthand doesn't wipe it.
    content.querySelectorAll('.topo-hub').forEach(el => {
      el.style.backgroundColor = 'transparent';
      el.style.borderColor = 'transparent';
      el.style.boxShadow = 'none';
    });
  }
}
