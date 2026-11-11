'use strict';
const checks = require('./_checks');
/**
 * A block's Background colour and Transparent reach the whole dual metric card.
 * The card's header and panes paint their own background, so before they painted
 * the default grey over the colour (or over a transparent card).
 * - the card defines --dual-surface, and the header and the panes paint it;
 * - blockStyle sets --dual-surface to the Background colour, or to transparent;
 * - transparent also clears the split layout's divider fill and the header rule.
 */
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('node:url');
const REPO = path.join(__dirname, '..');

function fakeElement(children = {}) {
  const props = {};
  return {
    props,
    style: {
      setProperty: (k, v, priority) => { props[k] = priority ? `${v} !${priority}` : v; },
      set background(v) { props.background = v; }, set borderColor(v) { props.borderColor = v; }, set boxShadow(v) { props.boxShadow = v; },
      set backgroundColor(v) { props.backgroundColor = v; }, set borderBottomColor(v) { props.borderBottomColor = v; }
    },
    querySelectorAll: selector => selector.split(',').map(s => s.trim()).flatMap(s => children[s] || [])
  };
}

(async () => {
  const css = fs.readFileSync(path.join(REPO, 'public/style.css'), 'utf8');
  const rule = sel => { const i = css.indexOf(sel + ' {'); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf('}', i)); };
  assert.match(rule('.dual-metric-card.stat-card'), /--dual-surface: var\(--surface-raised, var\(--card-bg\)\);[\s\S]*background: var\(--dual-surface\);/, 'the card defines its surface and paints it');
  assert.match(rule('.dual-metric-header'), /background: var\(--dual-surface, /, 'the header paints it');
  assert.match(rule('.dual-metric-pane'), /background: var\(--dual-surface, /, 'and so do the panes');
  console.log('ok - the card, its header and its panes paint one surface');

  const { applyBlockStyle } = await import(pathToFileURL(path.join(REPO, 'public/js/components/blockStyle.js')).href);

  const card = fakeElement();
  applyBlockStyle(card, { bgColor: '#ff0000' });
  assert.strictEqual(card.props['background-color'], '#ff0000 !important');
  assert.strictEqual(card.props['--dual-surface'], '#ff0000', 'the header and panes follow the Background colour');

  const plain = fakeElement();
  applyBlockStyle(plain, { bgColor: '#ffffff' });
  assert.strictEqual(plain.props['--dual-surface'], undefined, 'the default white is not a choice: the theme surface stays');
  console.log('ok - the Background colour reaches the header and panes');

  const body = fakeElement(), header = fakeElement();
  const transparent = fakeElement({ '.dual-metric-body': [body], '.dual-metric-header': [header] });
  applyBlockStyle(transparent, { transparent: true });
  assert.strictEqual(transparent.props['--dual-surface'], 'transparent');
  assert.strictEqual(transparent.props.background, 'transparent');
  assert.strictEqual(body.props.background, 'transparent', 'the split layout divider fill no longer shows through');
  assert.strictEqual(header.props.borderBottomColor, 'transparent', 'no rule under the title of a card with no surface');
  console.log('ok - Transparent clears the header, the panes and the divider fill');
  checks.done();
})().catch(err => { console.error(err); process.exitCode = 1; });
