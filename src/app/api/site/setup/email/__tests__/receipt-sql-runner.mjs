import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const db = new PGlite();
const root = process.cwd();
const here = resolve(root, 'src/app/api/site/setup/email/__tests__');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(`SELECT public.${name}(${params.map((_, i) => `$${i + 1}`).join(',')}) result`, params)).result;
const site = randomUUID(), token = randomUUID(), key = 'setup-email-v1:offline';
const payload = { email: 'owner@example.test', subject: 'Setup', message: 'Ready', omit_signature: true };
const claim = (k = key, s = site, p = payload, t = token) => rpc('claim_setup_email_delivery', [k, s, p, t]);
const receipt = { success: true, status: 'sent', messageId: 'actual-provider-id', recipient: payload.email, sent_at: '2026-10-07T00:00:00.000Z' };
const finalize = (state = 'sent', r = receipt, t = token) => rpc('finalize_setup_email_delivery', [key, site, payload, t, state, r]);
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
try {
  await db.exec(readFileSync(resolve(here, 'receipt-fixture.sql'), 'utf8'));
  await db.exec(readFileSync(resolve(root, 'supabase/migrations/20261007004000_setup_email_delivery_receipts.sql'), 'utf8'));
  await db.query('INSERT INTO sites(id,user_id) VALUES($1,$2)', [site, randomUUID()]);
  await check('atomic new claim and retry never reclaims', async () => {
    assert.equal((await claim()).outcome, 'acquired');
    assert.equal((await claim()).outcome, 'claimed');
    assert.equal((await claim(key, site, payload, randomUUID())).outcome, 'claimed');
    await db.exec("UPDATE setup_email_delivery_receipts SET claimed_at=now()-interval '10 years'");
    assert.equal((await claim()).outcome, 'claimed');
  });
  await check('same key exact payload and tenant conflicts reject before send', async () => {
    for (const field of ['email', 'subject', 'message']) assert.equal((await claim(key, site, { ...payload, [field]: payload[field] + ' ' })).outcome, 'conflict');
    assert.equal((await claim(key, randomUUID())).outcome, 'conflict');
    assert.equal((await claim(key, site, { ...payload, omit_signature: false })).outcome, 'conflict');
  });
  await check('wrong claim token cannot finalize or tamper', async () => {
    assert.equal((await finalize('sent', receipt, randomUUID())).outcome, 'conflict');
    assert.equal((await claim()).outcome, 'claimed');
  });
  await check('receipt requires actual status/id/recipient and preserves exact successful replay', async () => {
    for (const r of [{ ...receipt, messageId: '' }, { ...receipt, success: false }, { ...receipt, recipient: 'other@example.test' }, { ...receipt, status: 'queued' }]) {
      await assert.rejects(finalize('sent', r));
    }
    assert.deepEqual((await finalize()).receipt, receipt);
    assert.deepEqual((await claim()).receipt, receipt);
    assert.equal((await finalize('uncertain', { status: 'uncertain', success: false })).outcome, 'conflict');
    assert.equal((await finalize()).outcome, 'sent');
  });
  await check('uncertain and skipped receipts never auto-resend; evidence-only reconciliation is token-bound', async () => {
    for (const state of ['uncertain', 'skipped']) {
      const k = `${key}:${state}`;
      await claim(k);
      await rpc('finalize_setup_email_delivery', [k, site, payload, token, state, { success: false, status: state }]);
      assert.equal((await claim(k)).outcome, state);
      if (state === 'uncertain') assert.equal((await rpc('finalize_setup_email_delivery', [k, site, payload, token, 'sent', receipt])).outcome, 'sent');
    }
  });
  await check('missing/archived site cannot acquire', async () => {
    assert.equal((await claim(`${key}:missing`, randomUUID())).outcome, 'site_unavailable');
    await db.query('UPDATE sites SET archived_at=now() WHERE id=$1', [site]);
    assert.equal((await claim(`${key}:archived`)).outcome, 'site_unavailable');
    assert.equal((await claim()).outcome, 'sent');
  });
  await check('RLS and strict service-only RPC/table grants deny browser roles and direct mutation', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['claim_setup_email_delivery(text,uuid,jsonb,uuid)', 'finalize_setup_email_delivery(text,uuid,jsonb,uuid,text,jsonb)']) {
        assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok', [role, `public.${fn}`])).ok, false);
      }
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM setup_email_delivery_receipts'));
      await assert.rejects(claim());
      await db.exec('RESET ROLE');
    }
    for (const access of ['INSERT', 'UPDATE', 'DELETE']) assert.equal((await one("SELECT has_table_privilege('service_role','setup_email_delivery_receipts',$1) ok", [access])).ok, false);
    const rls = await one("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='setup_email_delivery_receipts'::regclass");
    assert.equal(rls.relrowsecurity, true); assert.equal(rls.relforcerowsecurity, true);
    await db.exec('SET ROLE service_role');
    assert.equal((await claim()).outcome, 'sent');
    assert.equal((await one('SELECT count(*) count FROM setup_email_delivery_receipts')).count, 3);
    await db.exec('RESET ROLE');
  });
  console.log(`Validated ${checks} durable setup email SQL scenarios`);
} finally { await db.close(); }