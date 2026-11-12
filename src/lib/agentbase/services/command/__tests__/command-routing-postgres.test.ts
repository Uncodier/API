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
    CREATE TABLE public.commands(id uuid PRIMARY KEY,site_id uuid REFERENCES sites(id));
    CREATE TABLE public.site_ownership(site_id uuid,user_id uuid);
    CREATE TABLE public.site_members(id uuid,site_id uuid,user_id uuid,status text,role text);
    CREATE FUNCTION public.site_member_has_effective_license(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`);
  for (const name of ['20261112010000_openrouter_customer_connections.sql', '20261112021000_openrouter_command_routing.sql']) {
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

const routing = { payer: 'customer', siteId: site, connectionId: connection, policyVersion: 1, credentialVersion: 1 };
const pin = (id: string, value = routing) => `SELECT openrouter_command_routing_pin('${id}','${site}',${json(value)});`;
const job = () => { const id = randomUUID(); db(`INSERT INTO commands VALUES('${id}','${site}');`); return id; };

it('concurrent identical pins are idempotent and cannot later change payer', async () => {
  const id = job();
  const run = () => promisify(execFile)(join(bin, 'psql'), [...args(), '-c', `SET ROLE service_role;${pin(id)}`], { env, encoding: 'utf8', timeout: 20000 });
  await Promise.all([run(), run()]);
  expect(db(`SELECT count(*) FROM openrouter_command_routing WHERE command_id='${id}';`)).toBe('1');
  expect(() => service(pin(id, { payer: 'platform', siteId: site } as any))).toThrow('immutable');
});
it('rejects foreign tenants, revoked keys and direct client writes', () => {
  const id = job();
  expect(() => service(pin(id, { ...routing, siteId: randomUUID() }))).toThrow('Invalid routing');
  expect(() => service(pin(id, { ...routing, credentialVersion: 2 }))).toThrow('unavailable');
  expect(() => db(`SET ROLE authenticated;${pin(id)}`)).toThrow('permission denied');
  expect(() => db(`SET ROLE service_role;UPDATE openrouter_command_routing SET routing='{}';`)).toThrow('permission denied');
});
it('rejects missing commands and permits explicit platform pins without a selected connection', () => {
  expect(() => service(pin(randomUUID()))).toThrow('Command site mismatch');
  const id = job();
  service(pin(id, { payer: 'platform', siteId: site } as any));
  expect(JSON.parse(db(`SELECT routing FROM openrouter_command_routing WHERE command_id='${id}';`))).toEqual({ payer: 'platform', siteId: site });
});
