'use strict';
const checks = require('./_checks');
// Layout editor: copy a block, paste it on any dashboard (checked in a browser
// too: Ctrl+C/V, the toolbar button, the library entry, undo, Controls page).
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/editor.js'), 'utf8');
const fn = name => { const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); assert.ok(m, name); return m[0]; };

const paste = fn('pasteBlock');
assert.match(paste, /id: newBlockId\(\)/, 'a pasted block gets its own id');
assert.match(paste, /JSON\.parse\(JSON\.stringify\(clip\.config/, 'and its own copy of the settings');
assert.match(paste, /typeFitsTab\(clip\.type\)/, 'switches stay on the Controls page, cards on dashboards');
assert.match(paste, /pushUndo\(\)/, 'a paste can be undone');
assert.match(fn('readClipboard'), /BLOCK_BUILDERS\.has\(c\.type\)/, 'only known block types are pasted');
assert.match(fn('copyBlock'), /localStorage\.setItem\(CLIPBOARD_KEY/, 'the copy outlives the dashboard it came from');
assert.match(src, /\['copy', 'clipboard', 'Copy, to paste here or on another dashboard'\]/, 'a Copy button on the block toolbar');
assert.match(src, /class="lib-item lib-paste"/, 'a Paste entry in Add block, for touch screens');
assert.match(src, /mod && !typing && !e\.shiftKey && !e\.altKey && key === 'c' && selectedBlockId && !textSelected/, 'Ctrl+C leaves typing and selected text alone');
assert.match(src, /mod && !typing && !e\.shiftKey && !e\.altKey && key === 'v' && readClipboard\(\)/, 'Ctrl+V only when a block was copied');
console.log('ok - editor copy and paste');
checks.done();
