import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const owner = '11111111-1111-4111-8111-111111111111';
const coowner = '22222222-2222-4222-8222-222222222222';
const assigned = '33333333-3333-4333-8333-333333333333';
const unrestricted = '44444444-4444-4444-8444-444444444444';
const inactive = '55555555-5555-4555-8555-555555555555';
const outsider = '66666666-6666-4666-8666-666666666666';
const site = '77777777-7777-4777-8777-777777777777';
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('test.user', true), '')::uuid $$;
    CREATE FUNCTION public.user_can(p_site_id uuid, p_command text) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT current_setting('test.allowed', true) = 'true' $$;
    CREATE TABLE sites(id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE site_ownership(site_id uuid, user_id uuid);
    CREATE TABLE site_members(site_id uuid, user_id uuid, status text, restrict_to_assigned_only boolean);
    CREATE TABLE icp_mining(id uuid DEFAULT gen_random_uuid(), site_id uuid, created_at timestamptz DEFAULT now());
    ALTER TABLE icp_mining ENABLE ROW LEVEL SECURITY;
    CREATE POLICY legacy_allow ON icp_mining FOR ALL TO authenticated USING(true) WITH CHECK(true);
    CREATE POLICY location_guard ON icp_mining AS RESTRICTIVE FOR ALL TO authenticated
      USING(current_setting('test.location', true) = 'false') WITH CHECK(current_setting('test.location', true) = 'false');
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON icp_mining TO authenticated;
    INSERT INTO auth.users VALUES ('${owner}'),('${coowner}'),('${assigned}'),('${unrestricted}'),('${inactive}'),('${outsider}');
    INSERT INTO sites VALUES ('${site}','${owner}');
    INSERT INTO site_ownership VALUES ('${site}','${coowner}');
    INSERT INTO site_members VALUES ('${site}','${assigned}','active',true),
      ('${site}','${unrestricted}','active',false), ('${site}','${inactive}','inactive',false);
    INSERT INTO icp_mining(site_id) VALUES ('${site}');
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/20261117203000_finder_list_ownership.sql'), 'utf8'));
}, 30000);
afterAll(async () => { await db.close(); });

async function identity(user: string, allowed = true, location = false) {
  await db.exec(`RESET ROLE; SET "test.user" = '${user}'; SET "test.allowed" = '${allowed}'; SET "test.location" = '${location}';`);
}

test.each([
  [owner, null, true], [coowner, null, true], [unrestricted, null, true],
  [assigned, assigned, true], [assigned, owner, false], [assigned, null, false],
  [inactive, inactive, false], [outsider, outsider, false], ['', owner, false],
])('row access actor %s owner %s = %s', async (actor, rowOwner, expected) => {
  await identity(actor as string);
  const { rows } = await db.query<{ allowed: boolean }>('SELECT public.finder_list_row_access($1,$2) AS allowed', [site, rowOwner]);
  expect(rows[0].allowed).toBe(expected);
});

test('operation capability still intersects ownership', async () => {
  await identity(owner, false);
  expect((await db.query<{ allowed: boolean }>('SELECT public.finder_list_row_access($1,$2) AS allowed', [site, owner])).rows[0].allowed).toBe(false);
});

test('authenticated default is actor; forged ownership rejected; existing location guard survives', async () => {
  await identity(assigned);
  await db.exec('SET ROLE authenticated');
  const inserted = await db.query<{ user_id: string }>('INSERT INTO icp_mining(site_id) VALUES ($1) RETURNING user_id', [site]);
  expect(inserted.rows[0].user_id).toBe(assigned);
  await expect(db.query('INSERT INTO icp_mining(site_id,user_id) VALUES ($1,$2)', [site, owner])).rejects.toMatchObject({ code: '42501' });
  await identity(assigned, true, true);
  await db.exec('SET ROLE authenticated');
  expect((await db.query('SELECT * FROM icp_mining')).rows).toEqual([]);
  await expect(db.query('INSERT INTO icp_mining(site_id) VALUES ($1)', [site])).rejects.toMatchObject({ code: '42501' });
});

test('legacy unattributed row stays hidden from assigned-only member', async () => {
  await identity(assigned);
  await db.exec('SET ROLE authenticated');
  expect((await db.query('SELECT * FROM icp_mining WHERE user_id IS NULL')).rows).toEqual([]);
});

test('jsonb equality ignores JS ordering/spacing differences for dedup', async () => {
  await identity(owner);
  const json = JSON.stringify({ user_id: assigned, site_id: site, query_snapshot: { title: 'Engineer', page: 0 } });
  const { rows } = await db.query<{ same: boolean; equal_text: boolean }>(
    'SELECT $1::jsonb = $2::jsonb AS same, $3::text = ($1::jsonb)::text AS equal_text',
    [json, JSON.stringify({ query_snapshot: { page: 0, title: 'Engineer' }, site_id: site, user_id: assigned }), json]);
  expect(rows[0]).toEqual({ same: true, equal_text: false });
});