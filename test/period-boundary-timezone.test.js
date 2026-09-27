const assert=require('node:assert/strict');const {periodBounds}=require('../modules/periodReducer');
const d=periodBounds('today',new Date('2024-03-10T16:00:00Z'),'America/New_York');assert.equal(d.today,'2024-03-10');assert.equal(d.end,'2024-03-11');
assert.equal(periodBounds('year',new Date('2024-12-31T20:00:00Z'),'America/New_York').end,'2025-01-01');console.log('period-boundary-timezone.test.js: PASS');
