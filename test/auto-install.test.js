'use strict';
const checks = require('./_checks');
const assert = require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epilykos-auto-')); process.chdir(dir); process.env.LOG_TO_FILE='false';
const db=require('../modules/database'); db.initializeDatabase();
const host=require('../modules/hostActions'); const seen=[];
host.call=async (action, body)=>{seen.push({action,...body});return {ok:true,state:'applying'};};
const updates=require('../modules/updates');
const result={supported:true,app:{available:true,auto_install_supported:true,state:'idle',latest_sequence:11,latest_digest:'sha256:'+'a'.repeat(64)}};
(async()=>{
  assert.equal(updates.autoInstall(),false); await updates.maybeAutoInstall(result); assert.equal(seen.length,0);
  db.setConfig('update_install_auto','true'); assert.equal(updates.autoInstall(),true);
  for (const r of [null,{supported:false}, {...result,error:'offline'}, {...result,app:{...result.app,auto_install_supported:false}}, {...result,app:{...result.app,error:'invalid signature'}}, {...result,app:{...result.app,state:'applying'}}, {...result,app:{...result.app,latest_digest:'unsigned'}}]) await updates.maybeAutoInstall(r);
  assert.equal(seen.length,0);
  await updates.maybeAutoInstall(result); assert.deepEqual(seen,[{action:'update_apply',target:'app',automatic:true,sequence:11,digest:result.app.latest_digest}]);
  process.env.UPDATE_CHECK='off'; await updates.maybeAutoInstall(result); assert.equal(seen.length,1); delete process.env.UPDATE_CHECK;
  const auth=require('../modules/sessionAuth'); auth.setSettingsPassword('test admin password');
  host.available=()=>true;
  const router=require('../routes/updates').router();
  const handler=router.stack.find(l=>l.route && l.route.path==='/auto-install').route.stack[0].handle;
  function enable(body) { let status=200,data; handler({body},{status(n){status=n;return this;},json(d){data=d;return this;}});return {status,data}; }
  assert.equal(enable({on:true,password:'wrong'}).status,403);
  assert.equal(enable({on:true,password:'test admin password'}).data.autoInstall,true);
  assert.equal(enable({on:false}).data.autoInstall,false);
  db.getDb().close();fs.rmSync(dir,{recursive:true,force:true});checks.done();
})().catch(e=>{console.error(e);process.exitCode=1;});
