'use strict';
const checks = require('./_checks');
// Settings page structure: every section is a sibling inside the settings form (or one of the four that sit
// outside it by design), and every section the menu links to exists. A section left unclosed nests the ones
// after it inside a hidden parent, and those pages open blank.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/settings.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'public/js/settings-shell.js'), 'utf8');

// A small, forgiving tag walker (the page has no void-tag surprises beyond the usual ones).
const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'col', 'area', 'base', 'wbr']);
const stack = [], sections = [];
let m;
const tag = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)([^>]*)>/g;
while ((m = tag.exec(html))) {
  if (!m[1]) continue;
  const name = m[1].toLowerCase(), closing = m[0][1] === '/', selfClosed = /\/>$/.test(m[0]);
  if (name === 'script' && !closing) { const end = html.indexOf('</script>', tag.lastIndex); tag.lastIndex = end >= 0 ? end + '</script>'.length : tag.lastIndex; continue; }
  if (VOID.has(name) || selfClosed) continue;
  if (closing) {
    const at = stack.lastIndexOf(name);
    assert.ok(at >= 0, `a stray </${name}> near character ${m.index}`);
    assert.equal(at, stack.length - 1, `</${name}> closes over an unclosed <${stack[stack.length - 1]}> near character ${m.index}`);
    stack.pop();
  } else {
    if (name === 'section') { const id = /\bid="(section-[\w-]+)"/.exec(m[2]); sections.push({ id: id && id[1], depth: stack.length, parent: stack[stack.length - 1] }); }
    stack.push(name);
  }
}
assert.deepEqual(stack, [], 'every tag in the page is closed');

const depths = new Map();
for (const s of sections) depths.set(s.depth, (depths.get(s.depth) || 0) + 1);
const formDepth = [...depths.entries()].sort((a, b) => b[1] - a[1])[0][0];
const BY_DESIGN_OUTSIDE = new Set(['section-notifications', 'section-system', 'section-updates', 'section-logs']);
for (const s of sections) {
  if (BY_DESIGN_OUTSIDE.has(s.id)) assert.equal(s.depth, formDepth - 1, `${s.id} sits just outside the settings form`);
  else assert.equal(s.depth, formDepth, `${s.id} is a sibling of the other sections, not nested inside one`);
}

// Every menu entry has its section and a title, and the other way round.
const nav = [...html.matchAll(/class="st-nav-link" data-section="([\w-]+)"/g)].map(x => x[1]);
const ids = new Set(sections.map(s => s.id.replace('section-', '')));
for (const n of nav) { assert.ok(ids.has(n), `the menu links to ${n}, which has no section`); assert.match(shell, new RegExp(`['"]?${n.replace('-', '[-]')}['"]?\\s*:`), `${n} has a title in settings-shell.js`); }
for (const id of ids) assert.ok(nav.includes(id), `${id} is not in the menu`);
assert.ok(ids.has('health') && ids.has('homeassistant'), 'the newer sections are there');
console.log('ok - settings sections');
checks.done();
