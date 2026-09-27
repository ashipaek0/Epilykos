'use strict';
(async () => {
const assert = require('assert');
const { resolveBinding } = await import('../public/js/dashboard-family-contract.mjs');
assert.deepStrictEqual(resolveBinding({ metric:'missing' }, {}), { status:'no-data', value:null, reason:'missing-binding' });
assert.deepStrictEqual(resolveBinding({ metric:'m' }, { m:null }), { status:'no-data', value:null, reason:'null-value' });
assert.doesNotThrow(() => resolveBinding(null, null));
console.log('dashboard-no-data-contract: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
