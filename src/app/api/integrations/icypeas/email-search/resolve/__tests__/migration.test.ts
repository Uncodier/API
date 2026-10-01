import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@jest/globals';

it('enforces service-only ACL, durable uniqueness/FK, atomic claims and immutable terminals in PostgreSQL', () => {
  // Existing PGlite dependency only. No Supabase connection, .env or config load.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const site='00000000-0000-4000-8000-000000000001';
    const other='00000000-0000-4000-8000-000000000002';
    const missing='00000000-0000-4000-8000-000000000003';
    const token='00000000-0000-4000-8000-000000000004';
    const token2='00000000-0000-4000-8000-000000000005';
    const table='public.icypeas_email_searches';
    const insert=(siteId,hash)=>db.query('INSERT INTO '+table+' (site_id,input_hash,firstname,lastname,domain_or_company) VALUES ($1,$2,$3,$4,$5) RETURNING *',[siteId,hash,'ada','lovelace','example.com']);
    const row=async(id)=>(await db.query('SELECT * FROM '+table+' WHERE id=$1',[id])).rows[0];
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE public.sites(id uuid PRIMARY KEY);');
      // Reproduce permissive Supabase defaults; selective GRANT alone would NOT
      // remove DELETE/TRUNCATE. The migration must revoke these defaults first.
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;');
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;');
      await db.exec(readFileSync('supabase/migrations/20261002000000_icypeas_email_searches.sql','utf8'));
      assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.icypeas_email_searches'::regclass")).rows[0].relrowsecurity,true);
      assert.equal((await db.query("SELECT count(*)::int n FROM pg_policies WHERE tablename='icypeas_email_searches'")).rows[0].n,0);
      for (const role of ['anon','authenticated','service_role']) {
        for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
          const allowed=(await db.query('SELECT has_table_privilege($1,$2,$3) allowed',[role,table,privilege])).rows[0].allowed;
          assert.equal(allowed,role==='service_role' && ['SELECT','INSERT','UPDATE'].includes(privilege),role+':'+privilege);
        }
        const execute=(await db.query("SELECT has_function_privilege($1,'public.guard_icypeas_email_search()','EXECUTE') allowed",[role])).rows[0].allowed;
        assert.equal(execute,false);
      }
      await db.query('INSERT INTO sites VALUES ($1),($2)',[site,other]);
      await db.exec('SET ROLE service_role');
      const job=(await insert(site,'a'.repeat(64))).rows[0];
      assert.equal(job.state,'ready');
      assert.deepEqual(job.emails,[]);
      await assert.rejects(()=>insert(site,'a'.repeat(64)),/unique constraint/);
      const otherJob=(await insert(other,'a'.repeat(64))).rows[0];
      assert.notEqual(otherJob.id,job.id);
      await assert.rejects(()=>insert(missing,'b'.repeat(64)),/foreign key/);
      await assert.rejects(()=>insert(site,'invalid-hash'),/check constraint/);
      await assert.rejects(()=>db.query('UPDATE '+table+" SET input_hash=$1 WHERE id=$2",['c'.repeat(64),job.id]),/identity is immutable/);
      await assert.rejects(()=>db.query('UPDATE '+table+" SET firstname='grace' WHERE id=$1",[job.id]),/identity is immutable/);
      const claims=await Promise.all(Array.from({length:8},()=>db.query('UPDATE '+table+" SET state='submitting',status='SUBMITTING' WHERE id=$1 AND site_id=$2 AND state='ready' AND search_id IS NULL RETURNING id",[job.id,site])));
      assert.equal(claims.reduce((n,r)=>n+r.rows.length,0),1);
      await assert.rejects(()=>db.query('UPDATE '+table+" SET state='ready' WHERE id=$1",[job.id]),/cannot be reset/);
      await db.query('UPDATE '+table+" SET state='unknown',status='SUBMISSION_UNKNOWN' WHERE id=$1",[job.id]);
      await assert.rejects(()=>db.query('UPDATE '+table+" SET state='submitting' WHERE id=$1",[job.id]),/cannot be resubmitted/);
      // Authorized, operator-reviewed reconciliation can attach an existing ID;
      // it must never reopen ready or send a new request to the provider.
      await db.query('UPDATE '+table+" SET state='pending',status='NONE',search_id='search-1',next_poll_at=now()-interval '1 minute' WHERE id=$1",[job.id]);
      await assert.rejects(()=>db.query('UPDATE '+table+" SET search_id='replacement' WHERE id=$1",[job.id]),/ID is immutable/);
      await assert.rejects(()=>db.query('UPDATE '+table+" SET state='pending',search_id='search-1' WHERE id=$1",[otherJob.id]),/unique constraint/);
      const before=await row(job.id);
      const polls=await Promise.all(Array.from({length:8},()=>db.query('UPDATE '+table+" SET poll_token=$1,next_poll_at=now()+interval '10 seconds' WHERE id=$2 AND site_id=$3 AND state='pending' AND next_poll_at=$4 AND next_poll_at<=now() RETURNING *",[token,job.id,site,before.next_poll_at])));
      assert.equal(polls.reduce((n,r)=>n+r.rows.length,0),1);
      assert.equal((await row(job.id)).poll_token,token);
      // Old poll token cannot save after a newer poll claim.
      await db.query('UPDATE '+table+' SET poll_token=$1 WHERE id=$2',[token2,job.id]);
      const stale=await db.query('UPDATE '+table+" SET status='IN_PROGRESS' WHERE id=$1 AND state='pending' AND poll_token=$2 RETURNING id",[job.id,token]);
      assert.equal(stale.rows.length,0);
      await db.query('UPDATE '+table+" SET state='matched',status='FOUND',emails=$1 WHERE id=$2 AND state='pending' AND poll_token=$3",[JSON.stringify([{email:'ada@example.com',certainty:'ultra_sure'}]),job.id,token2]);
      const cached=await row(job.id);
      assert.equal(cached.state,'matched');
      const oldPoll=await db.query('UPDATE '+table+" SET state='pending',status='IN_PROGRESS' WHERE id=$1 AND state='pending' RETURNING id",[job.id]);
      assert.equal(oldPoll.rows.length,0);
      await assert.rejects(()=>db.query('UPDATE '+table+" SET status='IN_PROGRESS' WHERE id=$1",[job.id]),/terminal result is immutable/);
      await assert.rejects(()=>db.query('DELETE FROM '+table+' WHERE id=$1',[job.id]),/permission denied/);
      assert.deepEqual(await row(job.id),cached);
      await db.exec('RESET ROLE');
      await assert.rejects(()=>db.query('DELETE FROM sites WHERE id=$1',[site]),/foreign key/);
      for (const role of ['anon','authenticated']) {
        await db.exec('SET ROLE '+role);
        await assert.rejects(()=>db.query('SELECT * FROM '+table),/permission denied/);
        await assert.rejects(()=>insert(site,'d'.repeat(64)),/permission denied/);
        await db.exec('RESET ROLE');
      }
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../../../..'), encoding: 'utf8', timeout: 40_000,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'IcyPeas SQL test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 45_000);