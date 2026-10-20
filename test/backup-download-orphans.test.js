'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {fork}=require('node:child_process');
const {acquireFileLease}=require('../modules/maintenanceFileLock');
const {reapRestoreStaging}=require('../modules/restoreStaging');
test('slow HTTP downloads retain private leases; process death permits only proven orphan cleanup',{skip:process.platform!=='linux',timeout:25000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'epilykos-download-orphan-')),data=path.join(root,'data'),lock=path.join(root,'maintenance.lock'),script=path.join(root,'server.js');
 fs.mkdirSync(data);const preserved=['.backup-Legacy','.snapshot-Legacy','.backup-owned-AbCd12'];
 for(const name of preserved){fs.mkdirSync(path.join(data,name));fs.writeFileSync(path.join(data,name,'energy.db'),'uncertain data');}
 const modules=path.resolve(__dirname,'../modules');
 fs.writeFileSync(script,`
 process.chdir(process.argv[2]);const db=require(${JSON.stringify(path.join(modules,'database'))});db.initializeDatabase();db.getDb().exec('CREATE TABLE payload(value BLOB);INSERT INTO payload VALUES(zeroblob(33554432))');
 const express=require(${JSON.stringify(require.resolve('express'))}),app=express();const {backupDatabase}=require(${JSON.stringify(path.join(modules,'backup'))});app.get('/backup',(req,res)=>backupDatabase(res));const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
 `);
 let child,first,second;
 try{
  child=fork(script,[root],{env:{...process.env,EPILYKOS_MAINTENANCE_LOCK:lock,LOG_TO_FILE:'false',ENC_KEY_FILE:path.join(root,'key')},stdio:['ignore','ignore','ignore','ipc']});
  let timer;const port=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('server startup timed out')),8000);child.once('message',m=>{clearTimeout(timer);resolve(m.port)});child.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error('server exited '+(signal||code)))});});
  function paused(){return new Promise((resolve,reject)=>{const request=http.get({hostname:'127.0.0.1',port,path:'/backup'},res=>{res.on('error',()=>{});if(res.statusCode!==200){res.resume();reject(new Error('HTTP '+res.statusCode));return;}res.pause();resolve({request,res});});request.setTimeout(10000,()=>request.destroy(new Error('download timed out')));request.on('error',reject);});}
  first=await paused();second=await paused();
  const rejected=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/backup'},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('slot response timed out')));});assert.equal(rejected,503);
  const jobs=fs.readdirSync(data).filter(n=>/^\.backup-owned-[A-Za-z0-9]{6}$/.test(n)&&!preserved.includes(n));assert.equal(jobs.length,2);
  for(const name of jobs)await assert.rejects(acquireFileLease(path.join(data,name,'.owner-lock'),0),e=>e.code==='LOCK_BUSY');
  const host=await acquireFileLease(lock,0);try{assert.deepEqual(await reapRestoreStaging(data),[]);}finally{host.release();}
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  const cleanupLease=await acquireFileLease(lock,0);try{assert.deepEqual((await reapRestoreStaging(data)).sort(),jobs.sort());}finally{cleanupLease.release();}
  for(const name of preserved)assert.equal(fs.readFileSync(path.join(data,name,'energy.db'),'utf8'),'uncertain data');
  for(const name of jobs)assert.equal(fs.existsSync(path.join(data,name)),false);
 }finally{for(const transfer of[first,second]){transfer?.res.destroy();transfer?.request.destroy();}if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}fs.rmSync(root,{recursive:true,force:true});}
});
