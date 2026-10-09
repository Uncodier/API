import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('atomic invoice cooldown checks sent count, intervals, duplicate keys and tenant ACLs offline', () => {
  const baseline = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261006230000_invoice_reminder_ledger.sql'), 'utf8');
  const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261008230000_invoice_reminder_cooldown.sql'), 'utf8');
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
    await db.exec(${JSON.stringify(baseline)});
    await db.exec(${JSON.stringify(migration)});
    const site = '00000000-0000-4000-8000-000000000001';
    const sale = '00000000-0000-4000-8000-000000000002';
    const claim = async (key, mode = 'progressive', days = 3) => (await db.query(
      'select public.claim_invoice_reminder_with_cooldown($1,$2,$3,current_date,$4,$5) receipt', [site,sale,key,days,mode])).rows[0].receipt;
    assert.equal((await claim('first')).claimed, true);
    assert.equal((await claim('second')).reason, 'reminder_uncertain');
    await db.query("update public.invoice_reminders set state='sent',sent_at=now()-interval '26 hours' where reminder_key='first'");
    assert.equal((await claim('first')).reason, 'repeat_interval');
    assert.equal((await claim('fixed', 'fixed', 3)).reason, 'repeat_interval');
    assert.equal((await claim('second')).claimed, true);
    await db.query("update public.invoice_reminders set state='sent',sent_at=now()-interval '26 hours' where reminder_key='second'");
    assert.equal((await claim('third')).claimed, true);
    await db.query("update public.invoice_reminders set state='sent',sent_at=now()-interval '2 days' where reminder_key='third'");
    assert.equal((await claim('fourth')).reason, 'repeat_interval');
    assert.equal((await claim('fourth', 'fixed', 1)).claimed, true);
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query("select has_function_privilege($1, 'public.claim_invoice_reminder_with_cooldown(uuid,uuid,text,date,integer,text)', 'EXECUTE') allowed", [role])).rows[0].allowed, false);
    }
    assert.equal((await db.query("select has_function_privilege('service_role','public.claim_invoice_reminder_with_cooldown(uuid,uuid,text,date,integer,text)','EXECUTE') allowed")).rows[0].allowed, true);
    assert.equal((await db.query('select public.claim_invoice_reminder_with_cooldown($1,$2,$3,current_date,3,$4) receipt', ['00000000-0000-4000-8000-000000000009',sale,'foreign','progressive'])).rows[0].receipt.reason, 'sale_not_found');
    await db.close(); console.log('ok');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(result.stderr?.slice(-8000) || result.error?.message || 'Invoice cooldown SQL regression failed');
  expect(result.stdout.trim()).toBe('ok');
}, 35000);