'use strict';
const checks = require('./_checks');
// The restore confirmation puts what it is about to restore (a file's size,
// a snapshot's size read from the page) in as text, never as HTML
// (CodeQL js/xss-through-dom, public/js/settings-shell.js).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../public/js/settings-shell.js'), 'utf8');
const m = src.match(/function restoreDialogBody\(what\) \{[\s\S]*?\n  \}\n/);
assert.ok(m, 'restoreDialogBody is there');

function el(tag) {
  const node = { tag, children: [], _html: '', _text: '', firstChild: null,
    appendChild(c) { this.children.push(c); return c; },
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); this.firstChild = { tag: 'label', fromHtml: String(v) }; }, get innerHTML() { return this._html; } };
  return node;
}
const ctx = { document: { createElement: el } };
vm.createContext(ctx);
vm.runInContext(m[0] + '\nthis.restoreDialogBody = restoreDialogBody;', ctx);

const hostile = '<img src=x onerror=alert(1)>';
const wrap = ctx.restoreDialogBody('this snapshot (' + hostile + ')');
const [p, label] = wrap.children;
assert.equal(p.tag, 'p');
assert.equal(p.textContent, 'This replaces all settings, metrics and history with this snapshot (' + hostile + '). Anything recorded since then is lost.');
assert.equal(p.innerHTML, '', 'the text is not parsed as HTML');
// The only HTML is the fixed checkbox, which carries nothing from the caller.
assert.match(label.fromHtml, /name="downloadFirst" checked/);
assert.doesNotMatch(label.fromHtml, /onerror|img/);
assert.doesNotMatch(m[0], /innerHTML = '<p>/, 'the sentence is no longer built as HTML');
checks.done();
