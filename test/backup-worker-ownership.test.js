'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork}=require('node:child_process');
const Database=require('better-sqlite3');
for(const cancel of [false,true])test(cancel?'disconnect during native backup validation reaps its worker before cleanup':'backup validator retains private and host leases after capture parent death',{skip:process.platform!=='linux',timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'epilykos-backup-worker-')),lock=path.join(root,'maintenance.lock'),gate=path.join(root,'gate'),script=path.join(root,'parent.js');
 const modulePath=path.resolve(__dirname,'../modules');
 fs.writeFileSync(script,`
 const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const original=cp.fork;
 cp.fork=function(script,args,options){process.send({phase:'precheck',file:args[0]});while(!fs.existsSync(process.argv[3]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);const child=original(script,args,options);process.send({phase:'worker',pid:child.pid});return child;};
 process.chdir(process.argv[2]);
 require(${JSON.stringify(path.join(modulePath,'database'))}).initializeDatabase();
 const {EventEmitter}=require('node:events');let downloaded=false;const response=Object.assign(new EventEmitter(),{headersSent:false,destroyed:false,status(){return this},json(e){process.send({error:e});},download(){downloaded=true;}});
 process.on('message',message=>{if(message==='cancel'){response.destroyed=true;response.emit('close');}});
 require(${JSON.stringify(path.join(modulePath,'backup'))}).backupDatabase(response).then(()=>process.send({phase:'finished',downloaded})).catch(e=>{console.error(e);process.exit(2)});

 `);
 let reader,worker,parent,finishedResolve;const finished=new Promise(resolve=>{finishedResolve=resolve});
 try{
  parent=fork(script,[root,gate],{env:{...process.env,EPILYKOS_MAINTENANCE_LOCK:lock,LOG_TO_FILE:'false',ENC_KEY_FILE:path.join(root,'key')},stdio:['ignore','ignore','ignore','ipc']});
  const workerReady=new Promise((resolve,reject)=>{parent.on('message',message=>{try{if(message.phase==='precheck'){reader=new Database(message.file,{timeout:1});reader.pragma('journal_mode = DELETE');reader.exec('BEGIN EXCLUSIVE');assert.throws(()=>{let probe;try{probe=new Database(message.file,{readonly:true,timeout:1});probe.pragma('quick_check');}finally{probe?.close();}},e=>e.code==='SQLITE_BUSY','fixture must actually block a read-only validator');fs.writeFileSync(gate,'ready');}if(message.phase==='finished')finishedResolve(message);if(message.phase==='worker'){worker=message.pid;resolve();}}catch(e){reject(e)}});parent.on('exit',(_,signal)=>{if(!worker)reject(new Error('parent exited before worker '+signal))});});
  let deadline; try { await Promise.race([workerReady,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('worker startup timed out')),6000)})]); } finally { clearTimeout(deadline); }
  const data=path.join(root,'data'),before=fs.readdirSync(data).find(n=>n.startsWith('.backup-owned-'));assert.ok(before);
  if(cancel){parent.send('cancel');let wait;let result;try{result=await Promise.race([finished,new Promise((_,reject)=>{wait=setTimeout(()=>reject(new Error('cancel did not settle')),6000)})]);}finally{clearTimeout(wait);}
   assert.equal(result.downloaded,false);assert.equal(fs.existsSync('/proc/'+worker),false);worker=null;assert.equal(fs.existsSync(path.join(data,before)),false);
   const lease=await require('../modules/maintenanceFileLock').acquireFileLease(lock,0);lease.release();
  }else{
  const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
  const {acquireFileLease}=require('../modules/maintenanceFileLock');
  await assert.rejects(acquireFileLease(lock,0),e=>e.code==='LOCK_BUSY');
  await assert.rejects(acquireFileLease(path.join(data,before,'.owner-lock'),0),e=>e.code==='LOCK_BUSY');
  const {reapRestoreStaging}=require('../modules/restoreStaging');assert.deepEqual(await reapRestoreStaging(data),[]);
  process.kill(worker,'SIGKILL');worker=null;reader.exec('ROLLBACK');reader.close();reader=null;
  for(let n=0;n<100&&fs.existsSync(path.join(data,before));n++){await reapRestoreStaging(data);await new Promise(r=>setTimeout(r,10));}
  assert.equal(fs.existsSync(path.join(data,before)),false);const lease=await acquireFileLease(lock,0);lease.release();
  }
 }finally{if(worker)try{process.kill(worker,'SIGKILL')}catch(_){}if(parent&&parent.exitCode===null&&parent.signalCode===null){const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;}if(reader)reader.close();fs.rmSync(root,{recursive:true,force:true});}
});
