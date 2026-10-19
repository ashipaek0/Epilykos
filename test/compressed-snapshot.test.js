'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const Database = require('better-sqlite3');
const { createCompressedSnapshot, getSnapshots } = require('../modules/compressedSnapshots');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-compressed-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
  const data = fs.mkdtempSync(path.join(root, 'case-')), dir = path.join(data, 'snapshots'); fs.mkdirSync(dir);
  const db = new Database(path.join(data, 'live.db')); db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE sample(value); INSERT INTO sample VALUES(42)');
  return { data, dir, db };
}
test('compressed snapshot contains committed WAL data and verified gzip', async () => {
  const f = fixture(); try {
    const result = await createCompressedSnapshot(f.db, f.dir, { directory: f.data });
    assert.match(result.name, /\.db\.gz$/); assert.match(result.sha256, /^[0-9a-f]{64}$/);
    const out = path.join(f.data, 'expanded.db'); await pipeline(fs.createReadStream(result.path), createGunzip(), fs.createWriteStream(out));
    const read = new Database(out); try { assert.equal(read.prepare('SELECT value FROM sample').get().value, 42); } finally { read.close(); }
    assert.equal(getSnapshots(f.dir).length, 1); assert.equal(fs.readdirSync(f.data).some(n => n.startsWith('.snapshot-owned-')), false);
  } finally { f.db.close(); }
});
test('generation ordering survives clock reversal and prunes only managed files', async () => {
  const f = fixture(); try {
    const unknown = path.join(f.dir, 'my-backup.db'); fs.writeFileSync(unknown, 'preserve');
    const first = await createCompressedSnapshot(f.db, f.dir, { directory: f.data, now: () => Date.UTC(2030,0,1) });
    const second = await createCompressedSnapshot(f.db, f.dir, { directory: f.data, now: () => Date.UTC(2020,0,1) });
    const third = await createCompressedSnapshot(f.db, f.dir, { directory: f.data, now: () => Date.UTC(2020,0,1) });
    const managed = getSnapshots(f.dir).filter(s => s.managed);
    assert.deepEqual(managed.map(s => s.name), [third.name, second.name]); assert.equal(fs.existsSync(first.path), false);
    assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve');
  } finally { f.db.close(); }
});
test('failed publication never overwrites an existing name or prunes prior successes', async () => {
  const f = fixture(); try {
    await createCompressedSnapshot(f.db, f.dir, { directory: f.data });
    await createCompressedSnapshot(f.db, f.dir, { directory: f.data });
    const before = fs.readdirSync(f.dir), original = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('collision'), { code: 'EEXIST' }); };
    try { await assert.rejects(createCompressedSnapshot(f.db, f.dir, { directory: f.data }), /collision/); } finally { fs.linkSync = original; }
    assert.deepEqual(fs.readdirSync(f.dir), before);
  } finally { f.db.close(); }
});
test('corrupt compressed output is never published or used to authorize pruning', async () => {
  const f = fixture(); try {
    const first = await createCompressedSnapshot(f.db,f.dir,{directory:f.data}), second = await createCompressedSnapshot(f.db,f.dir,{directory:f.data});
    await assert.rejects(createCompressedSnapshot(f.db,f.dir,{directory:f.data,onPhase(phase) {
      if (phase === 'compressed') { const job = fs.readdirSync(f.data).find(n => n.startsWith('.snapshot-owned-')); const file = path.join(f.data,job,'snapshot.db.gz'), fd = fs.openSync(file,'r+'); try { fs.writeSync(fd,Buffer.from([0]),0,1,0); } finally { fs.closeSync(fd); } }
    }}), /header|check|data/i);
    assert.deepEqual(getSnapshots(f.dir).filter(s=>s.managed).map(s=>s.name),[second.name,first.name]);
  } finally { f.db.close(); }
});
test('compression admission counts raw plus gzip allowance without deleting retained copies', async () => {
  const f = fixture(), original = fs.statfsSync;
  fs.statfsSync = () => ({bsize:1,blocks:1024**3,bavail:40*1024*1024});
  try { await assert.rejects(createCompressedSnapshot(f.db,f.dir,{directory:f.data}),e=>e.code==='INSUFFICIENT_STORAGE'); assert.equal(getSnapshots(f.dir).length,0); }
  finally { fs.statfsSync = original; f.db.close(); }
});
test('snapshot directory sync failure after link preserves both previous copies', async () => {
  const f = fixture(); try {
    const first = await createCompressedSnapshot(f.db,f.dir,{directory:f.data}), second = await createCompressedSnapshot(f.db,f.dir,{directory:f.data});
    const original = fs.fsyncSync; fs.fsyncSync = fd => { if (process.platform==='linux' && fs.readlinkSync('/proc/self/fd/'+fd)===f.dir) throw new Error('injected directory sync failure'); return original(fd); };
    try { if (process.platform==='linux') await assert.rejects(createCompressedSnapshot(f.db,f.dir,{directory:f.data}), /sync failure/); }
    finally { fs.fsyncSync = original; }
    assert.equal(fs.existsSync(first.path),true); assert.equal(fs.existsSync(second.path),true);
  } finally { f.db.close(); }
});
for (const phase of ['captured','linked','durable','detached','pruned']) test('SIGKILL at '+phase+' keeps complete published snapshots and reclaimable private staging', { skip: process.platform !== 'linux' }, async () => {
  const f = fixture(); try {
    const first=await createCompressedSnapshot(f.db,f.dir,{directory:f.data}), second=await createCompressedSnapshot(f.db,f.dir,{directory:f.data});
    const script = path.join(f.data,'kill.js');
    fs.writeFileSync(script,`const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});const {createCompressedSnapshot}=require(${JSON.stringify(path.resolve(__dirname,'../modules/compressedSnapshots'))});const db=new Database(process.argv[2]);createCompressedSnapshot(db,process.argv[3],{directory:process.argv[4],onPhase(p){if(p===process.argv[5])process.kill(process.pid,'SIGKILL')}}).catch(e=>{console.error(e);process.exit(2)});`);
    const child = require('node:child_process').spawn(process.execPath,[script,path.join(f.data,'live.db'),f.dir,f.data,phase],{stdio:'ignore'});
    const signal=await new Promise(resolve=>child.on('exit',(_,s)=>resolve(s))); assert.equal(signal,'SIGKILL');
    if(phase!=='pruned')assert.equal(fs.existsSync(first.path),true); assert.equal(fs.existsSync(second.path),true);
    await require('../modules/restoreStaging').reapRestoreStaging(f.data);
    assert.equal(fs.readdirSync(f.data).some(n=>n.startsWith('.snapshot-owned-')),false);
    const all=getSnapshots(f.dir).filter(s=>s.managed); assert.ok(all.length>=2);
    for(const snapshot of all){const out=path.join(f.data,'verify.db');await pipeline(fs.createReadStream(snapshot.path),createGunzip(),fs.createWriteStream(out));const read=new Database(out);try{assert.equal(read.prepare('SELECT value FROM sample').get().value,42);}finally{read.close();}}
  } finally { f.db.close(); }
});
test('cancellation while gzip output is being written cleans private files and keeps prior snapshots',async()=>{
 const f=fixture();f.db.exec('CREATE TABLE big(payload);INSERT INTO big VALUES(zeroblob(16000000))');const controller=new AbortController();let interrupted=false;
 const timer=setInterval(()=>{const job=fs.readdirSync(f.data).find(n=>n.startsWith('.snapshot-owned-'));if(!job)return;try{if(fs.statSync(path.join(f.data,job,'snapshot.db.gz')).size>0){interrupted=true;controller.abort(new Error('cancel compression'));}}catch(_){}},1);
 try{await assert.rejects(createCompressedSnapshot(f.db,f.dir,{directory:f.data,signal:controller.signal}),/abort|cancel/i);assert.equal(interrupted,true);assert.equal(getSnapshots(f.dir).length,0);assert.equal(fs.readdirSync(f.data).some(n=>n.startsWith('.snapshot-owned-')),false);}finally{clearInterval(timer);f.db.close();}
});
test('prune failure preserves the newly durable snapshot and all undeleted copies',async()=>{
 const f=fixture();try{const first=await createCompressedSnapshot(f.db,f.dir,{directory:f.data}),second=await createCompressedSnapshot(f.db,f.dir,{directory:f.data});const original=fs.unlinkSync;
 fs.unlinkSync=file=>{if(file===first.path)throw new Error('prune denied');return original(file)};
 try{await assert.rejects(createCompressedSnapshot(f.db,f.dir,{directory:f.data}),/prune denied/);}finally{fs.unlinkSync=original;}
 assert.equal(getSnapshots(f.dir).filter(s=>s.managed).length,3);assert.equal(fs.existsSync(second.path),true);
 }finally{f.db.close();}
});
