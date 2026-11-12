'use strict';
const checks = require('./_checks');
// The Controls page cards (switch, state select, button, quick actions, slider, rotary knob) take the same Style settings as
// the dashboard cards: colours, text size, transparent, glass, blur and frost.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const js = read('private/js/controls.js');
assert.ok(/import \{ applyBlockStyle \} from '\/js\/components\/blockStyle\.js'/.test(js), 'controls.js imports applyBlockStyle');
assert.ok(/const card = controlBuilders\[block\.type\]\(block\);\s*applyBlockStyle\(card, block\);[^\n]*\s*item\.appendChild\(card\);/.test(js), 'each card is styled before it is placed');

const html = read('private/pages/controls.html');
assert.ok(/<link rel="stylesheet" href="\/glass\.css">/.test(html), 'the page loads glass.css');
assert.ok(html.indexOf('/cards.css') < html.indexOf('/glass.css') && html.indexOf('/glass.css') < html.indexOf('/private/css/private.css'), 'glass.css comes after the card styles and before the page styles');

const css = read('public/glass.css');
assert.ok(!/\.dashboard-block >/.test(css.replace(/:is\(\.dashboard-block, \.ct-card\) >/g, '')), 'every glass rule that names a dashboard block also names a Controls page slot');
assert.ok(/:is\(\.dashboard-block, \.ct-card\) > :is\(\.glass-on, \.glass-own\)/.test(css), 'a card with its own glass reads its numbers on the Controls page too');
assert.ok(/body:not\(\.glass-cards\) :is\(\.dashboard-block, \.ct-card\) > \.glass-on/.test(css), 'a glass card on a page without glass starts from the usual numbers');

// The slot the cards sit in is .ct-card, and each control card's root is covered by the card list
assert.ok(/item\.className = 'ct-card'/.test(js));
for (const cls of ['.ep-card:not(.iframe-card)', '.button-card', '.switch-block', '.state-select-block']) assert.ok(css.includes(cls), cls + ' is in the glass card list');

checks.done();
