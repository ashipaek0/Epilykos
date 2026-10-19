'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork}=require('node:child_process');
const Database=require('better-sqlite3');
test('snapshot validator retains private and host leases after capture parent death',{skip:process.platform!=='linux',timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'epilykos-snapshot-worker-')),lock=path.join(root,'maintenance.lock'),gate=path.join(root,'gate'),script=path.join(root,'parent.js');
 const modulePath=path.resolve(__dirname,'../modules');
 fs.writeFileSync(script,`
 const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const original=cp.fork;
 cp.fork=function(script,args,options){process.send({phase:'precheck',file:args[0]});while(!fs.existsSync(process.argv[3]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);const child=original(script,args,options);process.send({phase:'worker',pid:child.pid});return child;};
 const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});const db=new Database(path.join(process.argv[2],'live.db'));db.exec('CREATE TABLE sample(value);INSERT INTO sample VALUES(42)');
 const {acquireLock}=require(${JSON.stringify(path.join(modulePath,'maintenanceLock'))});
 acquireLock('maintenance').then(async release=>{await require(${JSON.stringify(path.join(modulePath,'compressedSnapshots'))}).createCompressedSnapshot(db,path.join(process.argv[2],'snapshots'),{directory:process.argv[2],leaseFds:[release.leaseFd]});release();process.exit(0)}).catch(e=>{console.error(e);process.exit(2)});
 `);
 let reader,worker,parent;
 try{
  parent=fork(script,[root,gate],{env:{...process.env,EPILYKOS_MAINTENANCE_LOCK:lock,LOG_TO_FILE:'false'},stdio:['ignore','ignore','ignore','ipc']});
  const workerReady=new Promise((resolve,reject)=>{parent.on('message',message=>{try{if(message.phase==='precheck'){reader=new Database(message.file,{timeout:1});reader.exec('BEGIN EXCLUSIVE');fs.writeFileSync(gate,'ready');}if(message.phase==='worker'){worker=message.pid;resolve();}}catch(e){reject(e)}});parent.on('exit',(_,signal)=>{if(!worker)reject(new Error('parent exited before worker '+signal))});});
  let deadline; try { await Promise.race([workerReady,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('worker startup timed out')),6000)})]); } finally { clearTimeout(deadline); }
  const before=fs.readdirSync(root).find(n=>n.startsWith('.snapshot-owned-'));assert.ok(before);
  const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
  const {acquireFileLease}=require('../modules/maintenanceFileLock');
  await assert.rejects(acquireFileLease(lock,0),e=>e.code==='LOCK_BUSY');
  const {reapRestoreStaging}=require('../modules/restoreStaging');assert.deepEqual(await reapRestoreStaging(root),[]);
  process.kill(worker,'SIGKILL');worker=null;reader.exec('ROLLBACK');reader.close();reader=null;
  for(let n=0;n<100&&fs.existsSync(path.join(root,before));n++){await reapRestoreStaging(root);await new Promise(r=>setTimeout(r,10));}
  assert.equal(fs.existsSync(path.join(root,before)),false);const lease=await acquireFileLease(lock,0);lease.release();
 }finally{if(worker)try{process.kill(worker,'SIGKILL')}catch(_){}if(parent&&parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');if(reader)reader.close();fs.rmSync(root,{recursive:true,force:true});}
});
