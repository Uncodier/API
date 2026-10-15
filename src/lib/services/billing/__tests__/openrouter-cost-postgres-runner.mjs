import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Memory-only PostgreSQL: no credentials, environment files, inference or network.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const db = new PGlite();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const bill = async (site, event, cost) => (await one(
  'SELECT public.bill_openrouter_generation($1,$2,$3,$4) result', [site, event, cost, {}],
)).result;
const balance = site => one('SELECT to_jsonb(b) value FROM billing b WHERE site_id=$1', [site]);
const seed = async (plan = '2', legacy = '3', purchased = '4') => {
  const site = randomUUID();
  await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic usage')", [site]);
  await db.query('SELECT initialize_site_billing($1)', [site]);
  await db.query(`UPDATE billing SET plan_credits_available=$2::numeric,legacy_credits_available=$3::numeric,
    purchased_credits_available=$4::numeric,credits_used=0,monthly_credits_used=0,plan_credits_used=0 WHERE site_id=$1`,
  [site, plan, legacy, purchased]);
  return site;
};
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

try {
  await db.exec(readFileSync(resolve(root, 'src/lib/services/billing/__tests__/credit-fixture.sql'), 'utf8'));
  for (const name of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql', '20261003230002_classified_credit_operations.sql',
    '20261005230000_exact_credit_accounting_precision.sql', '20261014230000_openrouter_actual_cost_ledger.sql']) {
    await db.exec(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'));
  }
  await db.exec("SET request.jwt.claim.role='service_role'");
  const site = await seed(), event = `gen-${randomUUID()}`;
  await check('actual USD cost receives exactly 25% markup and repeated settlement cannot charge twice', async () => {
    const first = await bill(site, event, '0.04');
    assert.equal(first.success, true); assert.equal(first.charged, 0.05);
    assert.deepEqual(await bill(site, event, '0.04'), first);
    assert.equal((await one('SELECT credits_available = 8.95 AND credits_used = 0.05 ok FROM billing WHERE site_id=$1', [site])).ok, true);
    assert.equal((await one('SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1', [site])).n, 1);
  });
  await check('one generation cannot be assigned to a second site or mutated cost', async () => {
    const other = await seed();
    await assert.rejects(bill(other, event, '0.04'), /identity conflict/);
    await assert.rejects(bill(site, event, '0.05'), /identity conflict/);
  });
  await check('zero cost is an idempotent settled receipt, not a fabricated deduction', async () => {
    const id = randomUUID(), before = await balance(site);
    assert.equal((await bill(site, id, '0')).charged, 0);
    assert.equal((await bill(site, id, '0')).charged, 0);
    assert.deepEqual(await balance(site), before);
  });
  await check('invalid numeric values never touch the balance or charge ledger', async () => {
    const before = await balance(site);
    for (const value of ['NaN', 'Infinity', '-Infinity', '-1']) {
      await assert.rejects(bill(site, randomUUID(), value), /Invalid OpenRouter/);
    }
    assert.deepEqual(await balance(site), before);
  });
  await check('unknown provider cost is pending and can be reconciled exactly once later', async () => {
    const id = randomUUID(), before = await balance(site);
    assert.equal((await bill(site, id, null)).success, false);
    assert.deepEqual(await balance(site), before);
    assert.equal((await one('SELECT provider_cost IS NULL AND amount IS NULL AND state=\'pending\' ok FROM openrouter_generation_charges WHERE event_id=$1', [id])).ok, true);
    assert.equal((await bill(site, id, '0.04')).charged, 0.05);
    await bill(site, id, '0.04');
    assert.equal((await one('SELECT count(*)::int n FROM credit_transactions WHERE metadata->>\'generation_id\'=$1', [id])).n, 1);
  });
  await check('a generation bound to a harness hold cannot also be charged by a standalone adapter', async () => {
    const id = randomUUID(), before = await balance(site);
    await db.query(`INSERT INTO openrouter_generation_charges(event_id,site_id,provider_cost,amount,metadata)
      VALUES($1,$2,0.04,0.05,jsonb_build_object('harness_reservation_event',$3::text))`, [id,site,randomUUID()]);
    assert.equal((await bill(site,id,'0.04')).success,false);
    assert.deepEqual(await balance(site),before);
  });
  await check('known unpaid usage persists until a retry after funding, without a second inference', async () => {
    const empty = await seed('0','0','0'), id = randomUUID();
    assert.equal((await bill(empty, id, '1')).success, false);
    assert.equal((await one('SELECT state FROM openrouter_generation_charges WHERE event_id=$1', [id])).state, 'pending');
    await db.query('UPDATE billing SET purchased_credits_available=2 WHERE site_id=$1', [empty]);
    assert.equal((await bill(empty, id, '1')).success, true);
    await bill(empty, id, '1');
    assert.equal((await one('SELECT credits_available = 0.75 AND credits_used = 1.25 ok FROM billing WHERE site_id=$1', [empty])).ok, true);
  });
  await check('bucket order and exact fractional credit ledger are conserved', async () => {
    const precise = await seed('0.000000001','0.000000002','1'), id = randomUUID();
    await bill(precise, id, '0.000000008');
    assert.equal((await one(`SELECT plan_credits_available=0 AND legacy_credits_available=0 AND
      purchased_credits_available=0.999999993 AND credits_used=0.000000010 AND
      credits_available=plan_credits_available+legacy_credits_available+purchased_credits_available ok
      FROM billing WHERE site_id=$1`, [precise])).ok, true);
  });
  await check('credit ledger failure rolls back the generation receipt and every bucket', async () => {
    const id = randomUUID(), before = await balance(site);
    await db.exec(`CREATE FUNCTION fail_usage_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic ledger failure'; END; $$;
      CREATE TRIGGER fail_usage BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION fail_usage_ledger();`);
    await assert.rejects(bill(site, id, '0.01'), /Synthetic ledger failure/);
    assert.deepEqual(await balance(site), before);
    assert.equal((await one('SELECT count(*)::int n FROM openrouter_generation_charges WHERE event_id=$1', [id])).n, 0);
    await db.exec('DROP TRIGGER fail_usage ON credit_transactions; DROP FUNCTION fail_usage_ledger();');
  });
  await check('tenant/public callers cannot fabricate provider charges or read the ledger', async () => {
    assert.equal((await one("SELECT relrowsecurity FROM pg_class WHERE oid='openrouter_generation_charges'::regclass")).relrowsecurity, true);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(bill(site, randomUUID(), '0.01'), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM openrouter_generation_charges'), /permission denied/);
      await db.exec('RESET ROLE');
    }
    assert.equal((await one("SELECT has_function_privilege('service_role','bill_openrouter_generation(uuid,text,numeric,jsonb)','EXECUTE') ok")).ok, true);
  });
  console.log(`PASS ${checks} OpenRouter actual-cost PostgreSQL checks`);
} finally { await db.close(); }