'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSnapshotScheduler, DAY } = require('../modules/snapshotScheduler');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-scheduler-')); after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(overrides = {}) {
  let wall = 10 * 86400000, mono = 0, latest = null, runs = 0, healthy = true, busy = false;
  const warnings = [], stateFile = path.join(root, Math.random() + '.json');
  const options = { stateFile, wall: () => wall, monotonic: () => mono, latest: () => latest,
    healthy: () => healthy, acquire: async () => { if (busy) throw Object.assign(new Error('busy'),{code:'LOCK_BUSY'}); return () => {}; },
    run: async () => { runs++; latest = { name: 'success-' + runs, time: wall }; }, warn: (...args) => warnings.push(args), ...overrides };
  return { options, make: () => createSnapshotScheduler(options), advance(ms) { mono += ms; wall += ms; }, backwards(ms) { wall -= ms; }, setHealthy(v) { healthy = v; }, setBusy(v) { busy = v; }, setLatest(v) { latest = v; }, get wall() { return wall; }, get runs() { return runs; }, warnings };
}
test('coalesces missed days and single in-flight capture, then becomes current', async () => {
  let done; const f = fixture({ run: () => new Promise(r => { done = r; }) }), s = f.make();
  const first = s.tick(), second = s.tick(); await new Promise(r => setImmediate(r)); assert.equal(s.status().phase, 'capturing'); assert.equal(s.status().attempts, 1);
  done(); await Promise.all([first, second]); await s.stop();
});
test('health and maintenance busy defer without consuming retry budget', async () => {
  const f = fixture(), s = f.make(); f.setHealthy(false); await s.tick(); assert.equal(f.runs, 0); assert.equal(s.status().attempts, 0);
  f.setHealthy(true); f.setBusy(true); await s.tick(); assert.equal(s.status().attempts, 0);
  f.setBusy(false); f.advance(60000); await s.tick(); assert.equal(f.runs, 1); await s.stop();
});
test('failed attempts/backoff remain bounded and survive normal restart', async () => {
  let runs = 0; const f = fixture({ run: async () => { runs++; throw new Error('disk failure'); } }); let s = f.make();
  await s.tick(); await s.tick(); assert.equal(runs, 1); assert.equal(s.status().attempts, 1);
  await s.stop(); s = f.make(); await s.tick(); assert.equal(runs, 1);
  for (const delay of [5*60000,30*60000,2*3600000]) { f.advance(delay); await s.tick(); }
  assert.equal(runs, 4); f.advance(3*3600000); await s.tick(); assert.equal(runs, 4);
  f.advance(DAY); await s.tick(); assert.equal(runs, 5); await s.stop();
});
test('backwards clock cannot postpone captures or retry deadlines indefinitely', async () => {
  const f = fixture(), s = f.make(); await s.tick(); assert.equal(f.runs, 1);
  f.backwards(3*DAY); await s.tick(); assert.equal(f.runs, 2); await s.tick(); assert.equal(f.runs, 2); await s.stop();
});
test('stop aborts and awaits an active owned capture', async () => {
  let exited = false; const f = fixture({ run: async (_, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); exited = true; throw signal.reason; } }), s = f.make();
  const running = s.tick(); await new Promise(r => setImmediate(r)); await s.stop(); await running; assert.equal(exited, true); assert.equal(s.status().phase, 'stopped');
});
test('cannot persist an attempt means no capture, and uncertain state is preserved', async () => {
  const f = fixture(); fs.writeFileSync(f.options.stateFile, 'unknown user contents'); const s = f.make(); await s.tick(); assert.equal(f.runs, 0); assert.match(s.status().error, /state/i); assert.equal(fs.readFileSync(f.options.stateFile,'utf8'), 'unknown user contents'); await s.stop();
});
test('real fractional monotonic timestamps produce integer durable retry deadlines', async () => {
  let runs=0; const f=fixture({monotonic:()=>performance.now(),run:async()=>{runs++;}}),s=f.make();
  await s.tick(); assert.equal(runs,1); const state=JSON.parse(fs.readFileSync(f.options.stateFile)); assert.equal(Number.isSafeInteger(state.nextAt),true); await s.stop();
});

test('permanent maintenance errors are reported rather than disguised as busy',async()=>{
 const f=fixture({acquire:async()=>{throw new Error('lock permission denied')}}),s=f.make();await s.tick();assert.equal(s.status().phase,'failed');assert.match(s.status().error,/permission/);assert.equal(f.runs,0);await s.stop();
});
test('overdue warnings are bounded while unhealthy and only one missed-day capture is made',async()=>{
 const f=fixture(),s=f.make();f.setHealthy(false);await s.tick();await s.tick();assert.equal(f.warnings.filter(w=>w[0]==='backup.snapshot_overdue').length,1);
 f.advance(DAY);await s.tick();assert.equal(f.warnings.filter(w=>w[0]==='backup.snapshot_overdue').length,2);f.setHealthy(true);await s.tick();await s.tick();assert.equal(f.runs,1);await s.stop();
});
test('backwards clock during failures does not bypass monotonic retry backoff',async()=>{
 let runs=0;const f=fixture({run:async()=>{runs++;throw new Error('failure')}}),s=f.make();await s.tick();f.backwards(5*DAY);await s.tick();assert.equal(runs,1);f.advance(5*60000);await s.tick();assert.equal(runs,2);await s.stop();
});
test('restart with clock behind persisted state retains exhausted retry budget',async()=>{
 let runs=0;const f=fixture({run:async()=>{runs++;throw new Error('failure')}});let s=f.make();await s.tick();for(const delay of[5*60000,30*60000,2*3600000]){f.advance(delay);await s.tick();}await s.stop();f.backwards(5*DAY);s=f.make();await s.tick();assert.equal(runs,4);f.advance(DAY);await s.tick();assert.equal(runs,5);await s.stop();
});
for(const kind of ['text','partial','symlink','hardlink','oversize'])test('uncertain retry temporary '+kind+' is preserved and cannot start capture',async()=>{
 const f=fixture(),temporary=f.options.stateFile+'.tmp',outside=f.options.stateFile+'.outside';fs.writeFileSync(outside,'outside state');
 if(kind==='symlink')fs.symlinkSync(outside,temporary);else if(kind==='hardlink')fs.linkSync(outside,temporary);else fs.writeFileSync(temporary,kind==='partial'?'{"schema":1,':kind==='oversize'?'x'.repeat(4097):'unknown user contents');
 const before=fs.lstatSync(temporary),contents=fs.readFileSync(temporary,'utf8'),s=f.make();
 await s.tick();assert.equal(f.runs,0);assert.equal(s.status().phase,'failed');assert.match(s.status().error,/state/i);
 assert.equal(fs.lstatSync(temporary).ino,before.ino);assert.equal(fs.readFileSync(temporary,'utf8'),contents);assert.equal(fs.readFileSync(outside,'utf8'),'outside state');await s.stop();
});
test('recognizable interrupted retry temporary state can be reclaimed before the next attempt',async()=>{
 const f=fixture(),temporary=f.options.stateFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify({schema:1,count:1,windowAt:f.wall,lastAt:f.wall,nextAt:f.wall+300000,error:null,warnAt:null}));
 const s=f.make();await s.tick();assert.equal(f.runs,1);assert.equal(fs.existsSync(temporary),false);await s.stop();
});
