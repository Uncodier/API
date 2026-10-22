import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const db = new PGlite();
const rpc = async (name, args) => (await db.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) result`,args)).rows[0].result;
const site=randomUUID(),other=randomUUID(),user=randomUUID(),req=randomUUID();
const initial = () => ({id:randomUUID(),version:0,status:'queued',request:{requirementId:req,
  objective:'Offline lifecycle',repository:{url:'https://example.test/repo'},limits:{maxTurns:10,maxOutputTokens:1024,maxTotalTokens:100000,maxActiveMs:30000}},
  messages:[],turns:0,allocatedTokens:0,activeMs:0,uncertainOperations:[],createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()});
const insert = s => db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[s.id,site,user,s]);
const migration = name => db.exec(readFileSync(`supabase/migrations/${name}`,'utf8'));
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE sites(id uuid PRIMARY KEY);
    CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,status text);
    CREATE TABLE requirement_status(active_sandbox_id text); CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid,metadata jsonb);
    CREATE TABLE sandbox_billing_resources(sandbox_name text PRIMARY KEY,site_id uuid,owner_kind text,owner_id uuid,
      deletion_requested_at timestamptz,retired_at timestamptz);`);
  await migration('20261014010000_portable_harness_sessions.sql');
  await migration('20261022000001_sandbox_lifecycle_evidence.sql');
  await db.query('INSERT INTO sites VALUES($1),($2)',[site,other]);
  await db.query('INSERT INTO auth.users VALUES($1)',[user]);
  await db.query("INSERT INTO requirements VALUES($1,$2,'in-progress')",[req,site]);
  const s=initial();await insert(s);
  let owned=await rpc('claim_harness_session',[s.id,site,'owner',180]);
  const resource=`h-${s.id}`,token=randomUUID();
  const begin=(owner='owner',tenant=site,vm=resource,bootstrap=false,t=token)=>rpc('begin_harness_sandbox_cleanup',[s.id,tenant,owner,vm,t,bootstrap]);
  assert.equal(await begin(),false); // running is not idle.
  assert.equal(await begin('wrong',site,resource,true),false);
  assert.equal(await begin('owner',other,resource,true),false);
  assert.equal(await begin('owner',site,'unowned',true),false);
  assert.equal(await begin('owner',site,resource,true),true);
  assert.equal(await rpc('assert_harness_sandbox_cleanup',[s.id,site,randomUUID(),resource]),false);
  assert.equal(await rpc('finish_harness_sandbox_cleanup',[s.id,other,token]),false);
  // pause may fence work, but resume/claim cannot race a provider stop.
  assert.equal((await rpc('control_harness_session',[s.id,site,'pause',null])).status,'paused');
  await assert.rejects(()=>rpc('control_harness_session',[s.id,site,'resume',null]),/cleanup requires reconciliation/);
  await assert.rejects(()=>db.query("UPDATE harness_sessions SET snapshot=snapshot||'{\"status\":\"queued\"}'::jsonb,version=version+1 WHERE id=$1",[s.id]));
  assert.equal(await rpc('assert_harness_sandbox_cleanup',[s.id,site,token,resource]),true);
  assert.equal(await rpc('finish_harness_sandbox_cleanup',[s.id,site,token]),true);
  await rpc('control_harness_session',[s.id,site,'resume',null]);
  owned=await rpc('claim_harness_session',[s.id,site,'next',180]);
  owned=await rpc('save_harness_session',[s.id,site,'next',{...owned,workspace:{provider:'vercel',id:resource,root:'/vercel/sandbox'},status:'waiting'}]);
  assert.equal(await begin('owner'),false); // stale owner after pause/resume never stops successor.
  assert.equal(await begin('next',site,'different'),false);
  assert.equal(await begin('next'),true);
  assert.equal(await rpc('release_harness_session',[s.id,site,'next']),true); // release does not release cleanup claim.
  assert.equal(await rpc('assert_harness_sandbox_cleanup',[s.id,site,token,resource]),true);
  await assert.rejects(()=>rpc('control_harness_session',[s.id,site,'resume',null]),/cleanup requires reconciliation/);
  await rpc('finish_harness_sandbox_cleanup',[s.id,site,token]);
  await rpc('control_harness_session',[s.id,site,'resume',null]);
  owned=await rpc('claim_harness_session',[s.id,site,'terminal',180]);
  owned=await rpc('save_harness_session',[s.id,site,'terminal',{...owned,status:'failed'}]);
  await rpc('release_harness_session',[s.id,site,'terminal']);
  await db.query('INSERT INTO sandbox_billing_resources(sandbox_name,site_id,owner_kind,owner_id) VALUES($1,$2,$3,$4)',[resource,site,'requirement',req]);
  assert.equal(await begin(null),false); // requirement still active: failed is resumable, not deletion authority.
  await db.query("UPDATE requirements SET status='done' WHERE id=$1",[req]);
  await db.query('INSERT INTO requirement_status VALUES($1)',[resource]);
  assert.equal(await begin(null),false); // ambiguous legacy reference preserves work.
  await db.exec('DELETE FROM requirement_status');
  const paused=initial();await insert(paused);
  let p=await rpc('claim_harness_session',[paused.id,site,'paused',180]);
  await rpc('save_harness_session',[paused.id,site,'paused',{...p,status:'paused'}]);
  await rpc('release_harness_session',[paused.id,site,'paused']);
  assert.equal(await begin(null),false); // all same-requirement references matter, even with no workspace yet.
  await rpc('control_harness_session',[paused.id,site,'cancel',null]);
  assert.equal(await begin(null),true);
  await assert.rejects(()=>rpc('control_harness_session',[s.id,site,'resume',null]),/cleanup requires reconciliation/);
  await assert.rejects(()=>db.query("UPDATE requirements SET status='in-progress' WHERE id=$1",[req]),/cleanup requires reconciliation/);
  await assert.rejects(()=>db.query('UPDATE sandbox_billing_resources SET retired_at=NULL,deletion_requested_at=NULL WHERE sandbox_name=$1',[resource]),/cleanup requires reconciliation/);
  await db.query('UPDATE sandbox_billing_resources SET deletion_requested_at=clock_timestamp() WHERE sandbox_name=$1',[resource]);
  await db.query('UPDATE sandbox_billing_resources SET retired_at=clock_timestamp() WHERE sandbox_name=$1',[resource]);
  await rpc('finish_harness_sandbox_cleanup',[s.id,site,token]);
  for(const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(()=>begin(),/permission denied/);
    await assert.rejects(()=>rpc('finish_harness_sandbox_cleanup',[s.id,site,token]),/permission denied/);
    await db.exec('RESET ROLE');
  }
  console.log('PASS SQL cleanup fencing: bootstrap, stale owner, idle, pause/resume, terminal scope/all references, tenant ACL and pending stop retention');
} finally { await db.close(); }