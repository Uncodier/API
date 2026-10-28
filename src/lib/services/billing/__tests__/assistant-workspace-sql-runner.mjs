import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const db = new PGlite();
const root = process.cwd();
const migration = name => db.exec(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'));
const rpc = async (name, args) => (await db.query(`select ${name}(${args.map((_, i) => `$${i+1}`).join(',')}) result`, args)).rows[0].result;
const instance = randomUUID(), site = randomUUID(), other = randomUUID(), first = randomUUID(), second = randomUUID();
try {
  await db.exec(readFileSync(resolve(root, 'src/lib/services/billing/__tests__/credit-fixture.sql'), 'utf8'));
  await db.exec(`CREATE TABLE harness_sessions(id uuid PRIMARY KEY,site_id uuid,snapshot jsonb);
    CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid); CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid);
    CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,is_archived boolean default false);`);
  await db.query('insert into sites(id) values($1),($2)', [site,other]);
  await db.query('insert into billing(site_id,credits_available) values($1,100),($2,100)', [site,other]);
  await db.query('insert into remote_instances(id,site_id) values($1,$2)', [instance,site]);
  for (const name of ['20261003230000_credit_buckets_and_monthly_reset.sql', '20261003230002_classified_credit_operations.sql',
    '20261005230000_exact_credit_accounting_precision.sql', '20261014230002_sandbox_session_billing.sql',
    '20261028230000_assistant_workspace_resources.sql']) await migration(name);
  await assert.rejects(() => rpc('claim_assistant_workspace', [instance,other,first]), /scope unavailable/);
  const claimed = await rpc('claim_assistant_workspace', [instance,site,first]);
  assert.equal(claimed.sandbox_name, `a-${instance}`);
  assert.equal(claimed.initialized,false);
  assert.equal(await rpc('claim_assistant_workspace', [instance,site,second]),null);
  assert.equal(await rpc('renew_assistant_workspace',[instance,site,second,true]),false);
  assert.equal(await rpc('renew_assistant_workspace',[instance,site,first,true,`a-${instance}`]),true);
  assert.equal(await rpc('release_assistant_workspace',[instance,site,second]),false);
  assert.equal(await rpc('release_assistant_workspace',[instance,site,first]),true);
  assert.equal((await rpc('claim_assistant_workspace',[instance,site,second])).initialized,true);
  assert.equal(await rpc('renew_assistant_workspace',[instance,site,first,false]),false);
  await assert.rejects(() => rpc('renew_assistant_workspace',[instance,site,second,false,'h-foreign']),/Invalid.*resource/);
  const registered = await rpc('register_sandbox_billing',[`a-${instance}`,'instance',instance,site]);
  assert.equal(registered.success,true);
  assert.equal((await rpc('register_sandbox_billing',[`a-${instance}`,'instance',instance,site])).registered_at,registered.registered_at);
  await assert.rejects(() => rpc('register_sandbox_billing',[`a-${instance}`,'instance',instance,other]),/site ownership mismatch/);
  await assert.rejects(() => rpc('register_sandbox_billing',['h-foreign','instance',instance,site]),/Invalid instance sandbox name/);
  await db.query('update remote_instances set is_archived=true where id=$1',[instance]);
  assert.equal(await rpc('renew_assistant_workspace',[instance,site,second,false]),false);
  await assert.rejects(() => rpc('claim_assistant_workspace',[instance,site,first]),/scope unavailable/);
  for (const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(() => rpc('claim_assistant_workspace',[instance,site,first]),/permission denied/);
    await assert.rejects(() => db.query('select * from assistant_workspaces'),/permission denied/);
    await db.exec('RESET ROLE');
  }
  await db.query('delete from remote_instances where id=$1',[instance]);
  assert.equal((await db.query('select count(*)::int n from assistant_workspaces')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from assistant_workspace_deletions')).rows[0].n,1);
  assert.equal((await db.query('select deletion_requested_at from sandbox_billing_resources where owner_id=$1',[instance])).rows[0].deletion_requested_at,null);
  assert.equal((await db.query('select count(*)::int n from requirements')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from instance_plans')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from harness_sessions')).rows[0].n,0);
  console.log('Assistant workspace PostgreSQL: scope, exclusive lease, sticky initialization, ACL and billing passed');
} finally { await db.close(); }