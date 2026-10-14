import { spawnSync } from 'node:child_process';

it('reserves site credits exactly once under the live requirement owner before a provider dispatch', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite'; import { readFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto'; import assert from 'node:assert/strict';
    const db = new PGlite(), req=randomUUID(), site=randomUUID(), session=randomUUID(), event=randomUUID();
    try {
      await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid);CREATE TABLE balance(amount numeric);INSERT INTO balance VALUES(5);');
      await db.exec("CREATE FUNCTION assert_agent_requirement_run(uuid,text,integer,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='owner' $$;CREATE FUNCTION deduct_credits(uuid,numeric,text,text,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN IF (SELECT amount FROM public.balance)<$2 THEN RETURN jsonb_build_object('success',false);END IF; UPDATE public.balance SET amount=amount-$2;RETURN jsonb_build_object('success',true); END;$$;");
      await db.query('INSERT INTO requirements VALUES($1,$2)',[req,site]);
      await db.exec(readFileSync('supabase/migrations/20261014050000_agent_requirement_credit_reservation.sql','utf8'));
      const reserve=async(owner,id,amount)=>(await db.query('SELECT reserve_agent_requirement_credits($1,$2,0,$3,$4,$5) result',[req,owner,session,id,amount])).rows[0].result;
      assert.equal((await reserve('stale',event,2)).success,false);
      assert.equal((await reserve('owner',event,2)).success,true);
      assert.equal((await reserve('owner',event,2)).success,true);
      assert.equal(Number((await db.query('SELECT amount FROM balance')).rows[0].amount),3);
      assert.equal((await reserve('owner',randomUUID(),8)).success,false);
      await assert.rejects(reserve('owner',randomUUID(),-1));
      await db.exec('SET ROLE authenticated');
      await assert.rejects(reserve('owner',randomUUID(),1));
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});