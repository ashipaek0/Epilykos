'use strict';
const checks = require('./_checks');
// The layout editor saves a change that is still waiting for its short delay
// as soon as the page is hidden: on a phone, switching apps hides the page and
// it may be closed after that without the leave warning ever showing.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../public/js/editor.js'), 'utf8');

const hook = src.match(/document\.addEventListener\('visibilitychange', function\(\) \{\s*([^}]*)\}\);/);
assert.ok(hook, 'the editor listens for the page being hidden');
assert.match(hook[1], /document\.visibilityState === 'hidden' && saveTimer && !readOnly\) flushSave\(\)/, 'a waiting change is saved at once');
// The hook only fires the save that would have happened anyway; flushSave clears the timer itself.
assert.match(src, /async function flushSave\(\) \{\s*clearTimeout\(saveTimer\);\s*saveTimer = null;/);
// The leave warning is still there for desktop browsers.
assert.match(src, /window\.addEventListener\('beforeunload'/);
checks.done();
