import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { emptyCapabilities } from '../catalog';
const pgBin='/opt/homebrew/opt/postgresql@17/bin';
const available=['initdb','pg_ctl','psql'].every(file=>existsSync(path.join(pgBin,file)));
const suite=available?describe:describe.skip;
const migration=readFileSync(path.resolve(process.cwd(),'../market-fit/supabase/migrations/20261112010000_openrouter_customer_connections.sql'),'utf8');
const setupMigration=readFileSync(path.resolve(process.cwd(),'../market-fit/supabase/migrations/20261112030000_openrouter_setup.sql'),'utf8');
const planMigration=readFileSync(path.resolve(process.cwd(),'../market-fit/supabase/migrations/20261112022000_openrouter_plan_routing.sql'),'utf8');
const pilotMigration=readFileSync(path.resolve(process.cwd(),'../market-fit/supabase/migrations/20261112040000_openrouter_pilot_approval.sql'),'utf8');
const licensing=readFileSync(path.resolve(process.cwd(),'../market-fit/supabase/migrations/20261019220003_startup_trial_licensing.sql'),'utf8');
const effectiveLicenseHelper=licensing.slice(licensing.indexOf('CREATE FUNCTION public.site_member_has_effective_license'),licensing.indexOf('CREATE OR REPLACE FUNCTION public.get_site_member_license'));
const env={...process.env,LC_ALL:'C',LANG:'C'};
const site=randomUUID(), owner=randomUUID(), admin=randomUUID(), member=randomUUID(), foreign=randomUUID(), connection=randomUUID();
const candidate={id:connection,status:'connected',selected:false,credential_version:1,encrypted_credential:'synthetic-ciphertext',capabilities:emptyCapabilities(),catalog:[],catalog_updated_at:null,verified_at:null,consent_at:new Date().toISOString()};
const literal=(value:unknown)=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
const publish=(revision:number, value:unknown=candidate, actor=owner, token?:string)=>`SELECT public.openrouter_customer_publish('${site}','${actor}',${revision},${literal(value)},${token?`'${token}'`:'NULL'});`;
let directory='';
const args=()=>['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',directory,'-p','55449','-U','postgres','-d','postgres'];
const db=(sql:string)=>execFileSync(path.join(pgBin,'psql'),args(),{input:sql,encoding:'utf8',stdio:'pipe',timeout:20000,env}).trim();
const service=(sql:string)=>db(`SET ROLE service_role;${sql}`);
const asyncDb=async(sql:string)=>promisify(execFile)(path.join(pgBin,'psql'),[...args(),'-c',`SET ROLE service_role;${sql}`],{env,timeout:20000});
test('migration remains service-only, append-only and does not modify platform billing',()=>{
  expect(migration).toContain('REVOKE ALL ON'); expect(migration).toContain('pg_advisory_xact_lock');
  expect(migration).not.toMatch(/CREATE POLICY|GRANT .* TO authenticated|openrouter_generation_charges|deduct_credits/i);
});
suite('OpenRouter migration in disposable socket-only PostgreSQL',()=>{
  beforeAll(()=>{
    directory=mkdtempSync('/tmp/openrouter-pg-');
    execFileSync(path.join(pgBin,'initdb'),['-D',path.join(directory,'data'),'-U','postgres','-A','trust','--no-locale'],{stdio:'pipe',env,timeout:20000});
    execFileSync(path.join(pgBin,'pg_ctl'),['-D',path.join(directory,'data'),'-l',path.join(directory,'server.log'),'-o',`-F -p 55449 -k ${directory} -c listen_addresses='' -c lc_messages=C`,'-w','start'],{stdio:'pipe',env,timeout:20000});
    db(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE public.sites(id uuid PRIMARY KEY,user_id uuid,archived_at timestamptz,effective_plan text DEFAULT 'engine');
      CREATE TABLE public.site_ownership(site_id uuid,user_id uuid);
      CREATE TABLE public.instance_plans(id uuid PRIMARY KEY,site_id uuid);
      CREATE TABLE public.site_members(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid,user_id uuid,status text,role text,license_suspended boolean DEFAULT false,manually_disabled boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now());
      CREATE FUNCTION public.effective_site_plan(p_site_id uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT effective_plan FROM public.sites WHERE id=p_site_id $$;
      INSERT INTO auth.users VALUES('${owner}'),('${admin}'),('${member}'),('${foreign}');
      INSERT INTO public.sites(id,user_id) VALUES('${site}','${owner}');
      INSERT INTO public.site_members(site_id,user_id,status,role) VALUES('${site}','${admin}','active','admin'),('${site}','${member}','active','member');
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`);
    // Use the exact existing effective-license helper with a local plan-result seam.
    db(effectiveLicenseHelper);
    db(migration);
    db(planMigration);
    db(setupMigration);
    db(pilotMigration);
  },30000);
  afterAll(()=>{
    if(!directory)return;
    if(existsSync(path.join(directory,'data/postmaster.pid')))execFileSync(path.join(pgBin,'pg_ctl'),['-D',path.join(directory,'data'),'-m','fast','-w','stop'],{stdio:'pipe',env,timeout:20000});
    rmSync(directory,{recursive:true,force:true});
  });
  beforeEach(()=>db('TRUNCATE public.openrouter_customer_receipts,public.openrouter_customer_policies,public.openrouter_customer_connections CASCADE;'));
  test.each(['anon','authenticated'])('%s cannot retrieve ciphertext/catalog, publish, claim or write receipt',role=>{
    expect(()=>db(`SET ROLE ${role};SELECT * FROM public.openrouter_customer_connections;`)).toThrow('permission denied');
    expect(()=>db(`SET ROLE ${role};${publish(0)}`)).toThrow('permission denied');
    expect(()=>db(`SET ROLE ${role};SELECT public.openrouter_customer_refresh_claim('${site}','${owner}',0,'${randomUUID()}');`)).toThrow('permission denied');
    expect(()=>db(`SET ROLE ${role};SELECT public.openrouter_customer_receipt('{}');`)).toThrow('permission denied');
  });
  test('only owner/admin publishes; raw service role table mutations denied',()=>{
    for(const actor of [member,foreign])expect(()=>service(publish(0,candidate,actor))).toThrow('Forbidden');
    expect(JSON.parse(service(publish(0))).revision).toBe(1);
    expect(JSON.parse(service(publish(1,candidate,admin))).revision).toBe(2);
    expect(()=>service('UPDATE public.openrouter_customer_connections SET selected=true;')).toThrow('permission denied');
    expect(()=>service(publish(2,{...candidate,selected:true}))).toThrow('runtime not approved');
  });
  test('archived or manually disabled authority cannot publish through service RPC',()=>{
    db(`UPDATE public.sites SET archived_at=now();`);
    expect(()=>service(publish(0))).toThrow('Forbidden');
    db(`UPDATE public.sites SET archived_at=NULL; UPDATE public.site_members SET manually_disabled=true WHERE user_id='${admin}';`);
    expect(()=>service(publish(0,candidate,admin))).toThrow('Forbidden');
    db(`UPDATE public.site_members SET manually_disabled=false;`);
  });
  test('expired effective plan denies unsuspended admin and secondary owner at publication',()=>{
    db(`UPDATE public.sites SET effective_plan='commission';`);
    expect(db(`SELECT license_suspended FROM public.site_members WHERE user_id='${admin}';`)).toBe('f');
    expect(()=>service(publish(0,candidate,admin))).toThrow('Forbidden');
    db(`INSERT INTO public.site_ownership VALUES('${site}','${admin}');`);
    expect(()=>service(publish(0,candidate,admin))).toThrow('Forbidden');
    db(`DELETE FROM public.site_ownership; UPDATE public.sites SET effective_plan='engine';`);
    expect(JSON.parse(service(publish(0,candidate,admin))).revision).toBe(1);
  });
  test('null effective-license result denies rather than granting authority',()=>{
    db(`CREATE OR REPLACE FUNCTION public.site_member_has_effective_license(p_member_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT NULL::boolean $$;`);
    try { expect(()=>service(publish(0,candidate,admin))).toThrow('Forbidden'); }
    finally {
      db(effectiveLicenseHelper.replace('CREATE FUNCTION public.site_member_has_effective_license','CREATE OR REPLACE FUNCTION public.site_member_has_effective_license'));
    }
  });
  test('concurrent initial saves have one winner and immutable history',async()=>{
    const outcomes=await Promise.allSettled([asyncDb(publish(0)),asyncDb(publish(0))]);
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(db('SELECT count(*) FROM public.openrouter_customer_policies;')).toBe('1');
    expect(()=>service(publish(0))).toThrow('Revision conflict');
  });
  test('refresh deduplicates and stale refresh cannot clobber manual save',()=>{
    service(publish(0)); const token=randomUUID();
    expect(service(`SELECT public.openrouter_customer_refresh_claim('${site}','${owner}',1,'${token}');`)).toBe('t');
    expect(service(`SELECT public.openrouter_customer_refresh_claim('${site}','${owner}',1,'${randomUUID()}');`)).toBe('f');
    service(publish(1,{...candidate,capabilities:{...candidate.capabilities,text:{mode:'manual',modelId:'vendor/pinned',status:'unverified',reason:'manual'}}}));
    expect(()=>service(publish(1,candidate,owner,token))).toThrow('Revision conflict');
    expect(db("SELECT capabilities->'text'->>'modelId' FROM public.openrouter_customer_connections;")).toBe('vendor/pinned');
  });
  test('disconnect invalidates outstanding refresh and increments credential revision',()=>{
    service(publish(0)); const token=randomUUID();service(`SELECT public.openrouter_customer_refresh_claim('${site}','${owner}',1,'${token}');`);
    service(publish(1,{...candidate,status:'disconnected',credential_version:2,encrypted_credential:null}));
    expect(()=>service(publish(1,candidate,owner,token))).toThrow('Revision conflict');
    expect(db("SELECT status || ':' || credential_version::text || ':' || (encrypted_credential IS NULL)::text FROM public.openrouter_customer_connections;")).toBe('disconnected:2:true');
    expect(db('SELECT count(*) FROM public.openrouter_customer_policies;')).toBe('2');
  });
  test('receipt identity is tenant/version scoped, immutable and idempotent',()=>{
    service(publish(0));
    const receipt={site_id:site,connection_id:connection,event_id:randomUUID(),policy_version:1,credential_version:1,capability:'text',state:'uncertain',usage_evidence:{gateway_account_cost:null}};
    const write=(value:unknown)=>service(`SELECT public.openrouter_customer_receipt(${literal(value)});`);
    write(receipt);write(receipt);
    expect(()=>write({...receipt,state:'completed'})).toThrow('Receipt conflict');
    expect(()=>write({...receipt,site_id:randomUUID()})).toThrow('ownership mismatch');
    expect(()=>write({...receipt,credential_version:2})).toThrow('ownership mismatch');
    expect(()=>write({...receipt,event_id:randomUUID(),payer:'platform'})).toThrow('Invalid receipt');
    expect(()=>write({...receipt,event_id:randomUUID(),usage_evidence:{gateway_account_cost:-1}})).toThrow('Invalid cost evidence');
    expect(db("SELECT payer || ':' || platform_charge::text FROM public.openrouter_customer_receipts;")).toBe('customer:0');
    expect(db('SELECT count(*) FROM public.openrouter_customer_receipts;')).toBe('1');
  });
  test('setup consent budget is single-use, tenant scoped and charged to customer only', async()=>{
    service(publish(0)); const operation=randomUUID(); const fingerprint='a'.repeat(64);
    const claim=(actor=owner,id=operation)=>`SELECT public.openrouter_setup_claim('${site}','${actor}','${id}',1,'recommend','${fingerprint}',0.25);`;
    expect(()=>service(claim(member))).toThrow('Forbidden');
    expect(()=>db(`SET ROLE authenticated;${claim()}`)).toThrow('permission denied');
    const outcomes=await Promise.all([asyncDb(claim()),asyncDb(claim())]);
    expect(outcomes.map(result=>result.stdout.trim()).sort()).toEqual(['f','t']);
    expect(service(claim(owner,randomUUID()))).toBe('f');
    const finish=(evidence:unknown,state='completed')=>`SELECT public.openrouter_setup_finish('${site}','${operation}','${state}',${literal(evidence)});`;
    expect(()=>service(finish({platformCharge:0,gatewayCost:1}))).toThrow('cost not reconciled');
    expect(()=>service(finish({platformCharge:0,gatewayCost:0.01,apiKey:'forbidden'}))).toThrow('Invalid setup evidence');
    service(finish({platformCharge:0,gatewayCost:0.01}));
    service(finish({platformCharge:0,gatewayCost:0.01}));
    expect(()=>service(finish({platformCharge:0},'uncertain'))).toThrow('outcome conflict');
    expect(db('SELECT payer || \' : \' || platform_charge::text FROM public.openrouter_setup_runs;')).toBe('customer : 0');
    expect(()=>service('UPDATE public.openrouter_setup_runs SET state=\'dispatched\';')).toThrow('permission denied');
  });
  test('image availability requires completed same-credential same-endpoint setup evidence',()=>{
    service(publish(0));const operation=randomUUID(),artifact=randomUUID();
    const proof={modelId:'vendor/image',credentialVersion:1,adapterVersion:'openrouter-images-png-v1',expiresAt:new Date(Date.now()+3600000).toISOString(),operationId:operation,artifactId:artifact,providerTag:'provider/fixed'};
    const capabilities={...candidate.capabilities,image:{mode:'manual',modelId:'vendor/image',status:'available',reason:'Verified',verification:proof}};
    expect(()=>service(publish(1,{...candidate,capabilities}))).toThrow('Image proof does not match');
    expect(service(`SELECT public.openrouter_setup_claim('${site}','${owner}','${operation}',1,'verify','${'b'.repeat(64)}',0.25);`)).toBe('t');
    const evidence={platformCharge:0,gatewayCost:0.05,modelId:'vendor/image',artifactId:artifact,adapterVersion:'openrouter-images-png-v1',actualModel:'vendor/image',providerTag:'provider/fixed'};
    service(`SELECT public.openrouter_setup_finish('${site}','${operation}','completed',${literal(evidence)});`);
    expect(()=>service(publish(1,{...candidate,capabilities:{...capabilities,image:{...capabilities.image,verification:{...proof,providerTag:'other'}}}}))).toThrow('Image proof does not match');
    expect(JSON.parse(service(publish(1,{...candidate,capabilities}))).revision).toBe(2);
    expect(()=>service(publish(2,{...candidate,credential_version:2,capabilities}))).toThrow('Image verification required');
  });
  test('plan routing is private, immutable and constrained to the authoritative plan site',()=>{
    const plan=randomUUID();db(`INSERT INTO public.instance_plans VALUES('${plan}','${site}');`);
    const ref={payer:'platform',siteId:site};
    const pin=(routing:unknown=ref)=>`SELECT public.openrouter_plan_routing_pin('${plan}','${site}',${literal(routing)});`;
    expect(()=>db(`SET ROLE authenticated;${pin()}`)).toThrow('permission denied');
    expect(()=>service(pin({...ref,siteId:randomUUID()}))).toThrow('Invalid routing reference');
    expect(()=>service(pin({...ref,apiKey:'never-stored'}))).toThrow('Invalid platform reference');
    service(pin());service(pin());
    expect(()=>service(`UPDATE public.openrouter_plan_routing SET routing='{}';`)).toThrow('permission denied');
    expect(()=>service(`SELECT public.openrouter_plan_routing_pin('${randomUUID()}','${site}',${literal(ref)});`)).toThrow('Plan site mismatch');
    expect(db(`SELECT count(*) FROM public.openrouter_plan_routing WHERE plan_id='${plan}';`)).toBe('1');
  });
  test('customer selection requires database-owner rollout approval and expires closed',()=>{
    service(publish(0));
    expect(()=>service(publish(1,{...candidate,selected:true}))).toThrow('runtime not approved');
    expect(()=>service(`INSERT INTO public.openrouter_rollout_approvals(site_id,approved_until,approved_by,evidence_reference) VALUES('${site}',now()+interval '1 hour','test','offline');`)).toThrow('permission denied');
    db(`INSERT INTO public.openrouter_rollout_approvals(site_id,approved_until,approved_by,evidence_reference) VALUES('${site}',now()+interval '1 hour','isolated-test','offline');`);
    try {
      expect(JSON.parse(service(publish(1,{...candidate,selected:true}))).selected).toBe(true);
      db(`UPDATE public.openrouter_rollout_approvals SET approved_until=now()-interval '1 second' WHERE site_id='${site}';`);
      expect(()=>service(publish(2,{...candidate,selected:true}))).toThrow('runtime not approved');
      expect(JSON.parse(service(publish(2,candidate))).selected).toBe(false);
    } finally { db(`DELETE FROM public.openrouter_rollout_approvals WHERE site_id='${site}';`); }
  });
});
