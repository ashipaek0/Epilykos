/**
 * The look settings shared by the two bar gauge cards (Bar gauge and Bar gauge, segmented):
 *   orientation  'vertical' stands the bars up, one column per metric; anything else is the usual rows
 *   barEnds      'rounded' or 'square' ends on the bars; anything else keeps each card's own look
 * Both are saved on the card's config and drawn by the classes below (cards.css).
 *
 * @module components/barGaugeLook
 */

export const ORIENTATIONS = ['horizontal', 'vertical'];
export const BAR_ENDS = ['rounded', 'square'];

/** The valid look settings of a card's config: { vertical, ends } ('' = the card's own look). */
export function barGaugeLook(config) {
  const cfg = config || {};
  return {
    vertical: cfg.orientation === 'vertical',
    ends: BAR_ENDS.includes(cfg.barEnds) ? cfg.barEnds : ''
  };
}

/** The classes to put on the card. */
export function barGaugeClasses(config) {
  const look = barGaugeLook(config);
  return (look.vertical ? ' is-vertical' : '') + (look.ends ? ' bar-ends-' + look.ends : '');
}

/** Fill a bar to `pct` percent: along its width in a row, up its height in a column. */
export function setBarFill(fill, pct, vertical) {
  if (!fill) return;
  if (vertical) { fill.style.height = pct + '%'; fill.style.width = '100%'; }
  else fill.style.width = pct + '%';
}
