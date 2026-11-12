import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID, randomInt } from 'node:crypto';

// Disposable socket-only database. Never use project connection strings or .env.
const bin = '/opt/homebrew/opt/postgresql@17/bin';
const port = String(randomInt(20000, 60000));
let directory = '';
let started = false;
const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: 'C', LANG: 'C', NODE_ENV: 'test' };
const args = () => ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', port, '-U', 'postgres', '-d', 'postgres'];
const db = (sql: string) => execFileSync(join(bin, 'psql'), args(), { input: sql, encoding: 'utf8', stdio: 'pipe', timeout: 20000, env }).trim();
const json = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const site = randomUUID(), connection = randomUUID();
const intent = (key = randomUUID()) => ({ site_id: site, connection_id: connection, event_id: randomUUID(),
  operation_key: key, policy_version: 1, credential_version: 1, capability: 'text', requested_model: 'vendor/model' });
const dispatch = (v: ReturnType<typeof intent>) => `SELECT public.openrouter_customer_dispatch(${json(v)});`;
const service = (sql: string) => db(`SET ROLE service_role;${sql}`);

beforeAll(() => {
  directory = mkdtempSync('/tmp/customer-dispatch-pg-');
  execFileSync(join(bin, 'initdb'), ['-D', join(directory, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale'], { env, stdio: 'pipe', timeout: 30000 });
  execFileSync(join(bin, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'log'), '-o',
    `-F -p ${port} -k ${directory} -c listen_addresses=''`, '-w', 'start'], { env, stdio: 'pipe', timeout: 30000 });
  started = true;
  db(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.sites(id uuid PRIMARY KEY,user_id uuid,archived_at timestamptz);
    CREATE TABLE public.site_ownership(site_id uuid,user_id uuid);
    CREATE TABLE public.site_members(id uuid,site_id uuid,user_id uuid,status text,role text);
    CREATE FUNCTION public.site_member_has_effective_license(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`);
  for (const name of ['20261112010000_openrouter_customer_connections.sql', '20261112020000_openrouter_runtime_dispatch.sql', '20261112050000_openrouter_dispatch_attribution.sql']) {
    db(readFileSync(resolve(process.cwd(), '../market-fit/supabase/migrations', name), 'utf8'));
  }
  const actor = randomUUID();
  db(`INSERT INTO auth.users VALUES('${actor}'); INSERT INTO sites(id,user_id) VALUES('${site}','${actor}');
    INSERT INTO openrouter_customer_connections(id,site_id,status,selected,revision,policy_version,
      credential_version,encrypted_credential,capabilities,catalog,created_by,consent_at)
      VALUES('${connection}','${site}','connected',true,1,1,1,'synthetic','{}','[]','${actor}',now());
    INSERT INTO openrouter_customer_policies VALUES('${connection}',1,1,'{}',now());`);
}, 90000);
afterAll(() => {
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(directory, 'data'), '-w', '-m', 'immediate', 'stop'], { env, stdio: 'pipe', timeout: 20000 });
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it('concurrent independent transactions dispatch exactly once and stale intent never reacquires', async () => {
  const v = intent();
  const sql = `SET ROLE service_role;${dispatch(v)}`;
  const run = () => promisify(execFile)(join(bin, 'psql'), [...args(), '-c', sql], { env, encoding: 'utf8', timeout: 20000 });
  const results = await Promise.all([run(), run()]);
  expect(results.map(r => JSON.parse(r.stdout.trim()).claimed).sort()).toEqual([false, true]);
  db(`UPDATE openrouter_customer_dispatches SET created_at=now()-interval '10 years' WHERE event_id='${v.event_id}';`);
  expect(JSON.parse(service(dispatch({ ...v, event_id: randomUUID() }))).claimed).toBe(false);
});

it('atomically settles matched receipts and denies receipt without intent', () => {
  const v = intent();
  service(dispatch(v));
  const receipt = { ...v, operation_key: undefined, requested_model: undefined,
    usage_evidence: { gateway_account_cost: 0, requested_model: 'vendor/model' }, state: 'completed' };
  expect(() => service(`SELECT openrouter_customer_receipt(${json({ ...receipt, usage_evidence: { gateway_account_cost:0, requested_model:'other/model' } })});`))
    .toThrow('Receipt requires matching dispatch intent');
  service(`SELECT openrouter_customer_receipt(${json(receipt)});`);
  expect(db(`SELECT state FROM openrouter_customer_dispatches WHERE event_id='${v.event_id}';`)).toBe('completed');
  service(`SELECT openrouter_customer_receipt(${json(receipt)});`); // Lost RPC response is idempotent.
  expect(() => service(`SELECT openrouter_customer_receipt(${json({ ...receipt, event_id: randomUUID() })});`))
    .toThrow('Receipt requires matching dispatch intent');
});

it('denies stale credential, foreign tenant and client role even with well-shaped reference', () => {
  const v = intent();
  expect(() => service(dispatch({ ...v, credential_version: 2 }))).toThrow('Dispatch ownership mismatch');
  expect(() => service(dispatch({ ...v, site_id: randomUUID() }))).toThrow('Dispatch ownership mismatch');
  expect(() => db(`SET ROLE authenticated;${dispatch(v)}`)).toThrow('permission denied');
  expect(() => db('SET ROLE anon;SELECT * FROM openrouter_customer_dispatches;')).toThrow('permission denied');
});

it('reconciliation records operator evidence without issuing a new claim', () => {
  const v = intent();
  service(dispatch(v));
  const evidence = { generation_id: 'offline-generation', gateway_account_cost: 0.02, reason: 'Reviewed provider receipt' };
  service(`SELECT openrouter_customer_dispatch_reconcile('${v.event_id}','${randomUUID()}','completed',${json(evidence)});`);
  expect(db(`SELECT resolution FROM openrouter_customer_dispatch_reconciliations WHERE event_id='${v.event_id}';`)).toBe('completed');
  expect(JSON.parse(service(dispatch(v))).claimed).toBe(false);
  expect(() => service(`SELECT openrouter_customer_dispatch_reconcile('${v.event_id}','${randomUUID()}','rejected',${json({ reason: 'retry' })});`))
    .toThrow('Dispatch outcome conflict');
});