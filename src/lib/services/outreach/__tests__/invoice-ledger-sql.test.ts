import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('offline PostgreSQL ledger verifies interval, atomic claims, tenant ACLs and safe cancellation', () => {
  const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261006230000_invoice_reminder_ledger.sql'), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite();
    await db.exec(\`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.sites(id uuid primary key);
      create table public.sales(id uuid primary key, site_id uuid, lead_id uuid, status text, amount_due numeric, due_date date, currency text);
      create table public.messages(id uuid primary key, custom_data jsonb);
      insert into public.sites values ('00000000-0000-4000-8000-000000000001');
      insert into public.sales values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', null, 'pending', 100, current_date, 'USD');
    \`);
    await db.exec(${JSON.stringify(migration)});
    const site = '00000000-0000-4000-8000-000000000001';
    const sale = '00000000-0000-4000-8000-000000000002';
    const claim = async key => (await db.query('select public.claim_invoice_reminder($1,$2,$3,current_date,3) as receipt', [site,sale,key])).rows[0].receipt;
    const results = await Promise.all(Array.from({length:8}, (_, n) => claim('key-'+n)));
    assert.equal(results.filter(r => r.claimed).length, 1);
    assert.equal(results.filter(r => r.reason === 'reminder_uncertain').length, 7);
    const receipt = results.find(r => r.claimed).reminder;
    for (const role of ['anon','authenticated']) {
      assert.equal((await db.query("select has_function_privilege($1, 'public.claim_invoice_reminder(uuid,uuid,text,date,integer)', 'EXECUTE') allowed", [role])).rows[0].allowed, false);
      assert.equal((await db.query("select has_table_privilege($1, 'public.invoice_reminders', 'SELECT') allowed", [role])).rows[0].allowed, false);
    }
    assert.equal((await db.query("select has_function_privilege('service_role','public.claim_invoice_reminder(uuid,uuid,text,date,integer)','EXECUTE') allowed")).rows[0].allowed, true);
    const foreign = (await db.query('select public.claim_invoice_reminder($1,$2,$3,current_date,3) receipt', ['00000000-0000-4000-8000-000000000009',sale,'foreign'])).rows[0].receipt;
    assert.equal(foreign.reason, 'sale_not_found');
    const msg = '00000000-0000-4000-8000-000000000003';
    const metadata = {status:'accepted',invoice_due_date:new Date().toISOString().slice(0,10),invoice_amount_due:100,invoice_currency:'USD'};
    await db.query('insert into public.messages values ($1,$2)', [msg,JSON.stringify(metadata)]);
    await db.query("update public.invoice_reminders set state='ready',message_id=$1 where id=$2", [msg,receipt.id]);
    assert.equal((await claim('next')).reason,'ready');
    await db.query('update public.sales set amount_due=50 where id=$1',[sale]);
    const cancel = async () => (await db.query('select public.cancel_stale_invoice_reminder($1,$2) cancelled',[site,sale])).rows[0].cancelled;
    for (const evidence of [{outreach_delivery:{state:'dispatching'}},{outreach_delivery:{state:'uncertain'}},
      {outreach_delivery:{attempt_id:'unknown'}},{outreach_delivery:null},{sent_at:new Date().toISOString()},
      {provider_message_id:'provider'},{delivery:{success:true}}]) {
      await db.query('update public.messages set custom_data=$1 where id=$2',[JSON.stringify({...metadata,...evidence}),msg]);
      assert.equal(await cancel(),false); // External evidence cannot be released.
    }
    await db.query('update public.messages set custom_data=$1 where id=$2',[JSON.stringify(metadata),msg]);
    assert.equal(await cancel(),true);
    assert.equal((await db.query('select custom_data from public.messages where id=$1',[msg])).rows[0].custom_data.status,'cancelled');
    const next = await claim('after-cancel'); assert.equal(next.claimed,true);
    await db.query("update public.invoice_reminders set state='sent',sent_at=now() where id=$1",[next.reminder.id]);
    assert.equal((await claim('tomorrow')).reason,'repeat_interval');
    await db.query("update public.invoice_reminders set sent_at=now()-interval '4 days' where id=$1",[next.reminder.id]);
    assert.equal((await claim('next-window')).claimed,true);
    await db.query("update public.sales set status='completed',amount_due=0 where id=$1",[sale]);
    assert.equal((await claim('paid')).reason,'invoice_not_due');
    await db.close(); console.log('ok');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(result.stderr?.slice(-8000) || result.error?.message || 'Invoice PostgreSQL regression failed');
  expect(result.stdout.trim()).toBe('ok');
}, 35000);