import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const owner = '11111111-1111-4111-8111-111111111111';
const assigned = '22222222-2222-4222-8222-222222222222';
const outsider = '33333333-3333-4333-8333-333333333333';
const site = '44444444-4444-4444-8444-444444444444';
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let db: PGlite;
let selectedId: string;
const migration = 'supabase/migrations/20261117220000_finder_selected_list_members.sql';
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user', true), '')::uuid $$;
    CREATE FUNCTION user_can(uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.allowed',true) = 'true' AND current_setting('test.denied',true) IS DISTINCT FROM $2 $$;
    CREATE FUNCTION current_user_has_location_restrictions() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.location',true) = 'true' $$;
    CREATE FUNCTION current_user_has_site_location_restrictions(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.location',true) = 'true' $$;
    CREATE TABLE sites(id uuid PRIMARY KEY,user_id uuid);
    CREATE TABLE site_ownership(site_id uuid,user_id uuid);
    CREATE TABLE site_members(site_id uuid,user_id uuid,status text,restrict_to_assigned_only boolean);
    CREATE TABLE role_queries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),query jsonb NOT NULL,
      query_hash text GENERATED ALWAYS AS (md5(query::text)) STORED UNIQUE);
    CREATE TABLE icp_mining(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid REFERENCES sites(id),
      role_query_id uuid NOT NULL REFERENCES role_queries(id),name text,status text DEFAULT 'pending',
      total_targets integer DEFAULT 0,processed_targets integer DEFAULT 0,found_matches integer DEFAULT 0,
      current_page integer DEFAULT 0,current_page_offset integer DEFAULT 0,started_at timestamptz,finished_at timestamptz,
      last_progress_at timestamptz,last_error text,errors jsonb DEFAULT '[]',icp_criteria jsonb,created_at timestamptz DEFAULT now());
    ALTER TABLE icp_mining ENABLE ROW LEVEL SECURITY;
    CREATE POLICY legacy_allow ON icp_mining FOR ALL TO authenticated USING(true) WITH CHECK(true);
    CREATE POLICY location_guard ON icp_mining AS RESTRICTIVE FOR ALL TO authenticated
      USING(NOT current_user_has_location_restrictions()) WITH CHECK(NOT current_user_has_location_restrictions());
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON icp_mining TO authenticated;
    INSERT INTO auth.users VALUES ('${owner}'),('${assigned}'),('${outsider}');
    INSERT INTO sites VALUES ('${site}','${owner}');
    INSERT INTO site_members VALUES ('${site}','${assigned}','active',true);
  `);
  await db.exec(readFileSync(resolve('supabase/migrations/20261117203000_finder_list_ownership.sql'), 'utf8'));
  // Execute the full canonical checkpoint migration, including its real guard.
  await db.exec(readFileSync(resolve('../Workflows/supabase/migrations/20260929230000_icp_mining_execution_checkpoints.sql'), 'utf8'));
  await db.exec(readFileSync(resolve(migration), 'utf8'));
}, 30000);
afterAll(async () => { await db.close(); });
async function identity(user = owner, denied = '', location = false) {
  await db.exec(`RESET ROLE; SET "test.user"='${user}'; SET "test.allowed"='true'; SET "test.denied"='${denied}'; SET "test.location"='${location}'; SET ROLE authenticated;`);
}
async function create(n: number, ids = ['person:B', 'person:A', 'person:B'], name = 'Selected list') {
  const result = await db.query<{ result: any }>('SELECT finder_create_selected_list($1,$2,$3,$4) AS result', [site, name, ids, requestId(n)]);
  return result.rows[0].result;
}
async function append(id: string, n: number, ids = ['person:C']) {
  return (await db.query<{ result: any }>('SELECT finder_append_selected_people($1,$2,$3,$4) AS result', [id, site, ids, requestId(n)])).rows[0].result;
}
test('creates selected-only list atomically with verified actor, opaque ordered IDs and safe query', async () => {
  await identity();
  const result = await create(1);
  selectedId = result.list.id;
  expect(result.added_count).toBe(2);
  expect(result.list.total_targets).toBe(2);
  const members = (await db.query<{ person_id: string; created_by: string }>('SELECT person_id,created_by FROM icp_mining_people ORDER BY ordinal')).rows;
  expect(members).toEqual([{ person_id: 'person:B', created_by: owner }, { person_id: 'person:A', created_by: owner }]);
  await db.exec('RESET ROLE');
  const mining = (await db.query<any>('SELECT m.user_id,m.icp_criteria,q.query FROM icp_mining m JOIN role_queries q ON q.id=m.role_query_id WHERE m.id=$1', [selectedId])).rows[0];
  expect(mining.user_id).toBe(owner);
  expect(mining.icp_criteria.source).toBe('selected_people');
  expect(mining.query.person_id).toBe('__selected_people_only__');
});
test('create replay after completion returns same list; changed payload conflicts; deletion keeps tombstone', async () => {
  await db.exec('RESET ROLE');
  await db.query("UPDATE icp_mining SET status='completed' WHERE id=$1", [selectedId]);
  await identity();
  expect((await create(1)).list.id).toBe(selectedId);
  await expect(create(1, ['changed'])).rejects.toMatchObject({ code: '23505' });
  const disposable = await create(2);
  await db.query('DELETE FROM icp_mining WHERE id=$1', [disposable.list.id]);
  await expect(create(2)).rejects.toMatchObject({ code: 'P0002' });
});
test('append completed fenced row resumes pending without resetting cursor; replay is exact', async () => {
  await db.exec('RESET ROLE');
  await db.exec(`SET "app.icp_execution_owner"='${requestId(100)}'`);
  await db.query("UPDATE icp_mining SET execution_run_id=$2,current_page=8,current_page_offset=4,processed_targets=2,finished_at=now() WHERE id=$1", [selectedId, requestId(100)]);
  await db.exec(`SET "app.icp_execution_owner"=''`);
  await identity();
  const result = await append(selectedId, 3);
  expect(result.list.status).toBe('pending');
  expect(result.list.total_targets).toBe(3);
  expect(result.added_count).toBe(1);
  expect(await append(selectedId, 3)).toEqual(result);
  expect((await append(selectedId, 4)).added_count).toBe(0);
  const row = (await db.query<any>('SELECT * FROM icp_mining WHERE id=$1', [selectedId])).rows[0];
  expect(row.current_page).toBe(8);
  expect(row.current_page_offset).toBe(4);
  expect(row.processed_targets).toBe(2);
  expect(row.execution_run_id).toBe(requestId(100));
  expect(row.execution_active).toBe(false);
  expect((await db.query<any>("SELECT current_setting('app.icp_execution_owner',true) AS owner")).rows[0].owner).toBe('');
});
test('append active search preserves search accounting/status/snapshot with canonical guard', async () => {
  await db.exec('RESET ROLE');
  await db.exec(`SET "app.icp_execution_owner"='${requestId(100)}'`);
  await db.query("UPDATE icp_mining SET status='running',execution_active=true,icp_criteria='{}',current_page_snapshot='{\"page\":8,\"candidates\":[]}' WHERE id=$1", [selectedId]);
  await db.exec(`SET "app.icp_execution_owner"=''`);
  await identity();
  const result = await append(selectedId, 5, ['person:D']);
  expect(result.list.total_targets).toBe(3);
  expect(result.list.status).toBe('running');
  const row = (await db.query<any>('SELECT * FROM icp_mining WHERE id=$1', [selectedId])).rows[0];
  expect(row.execution_active).toBe(true);
  expect(row.current_page_snapshot).toEqual({ page: 8, candidates: [] });
  expect(row.checkpoint_version).toBe(0);
});
test('assigned-only, outsider, capability, location and anonymous denials', async () => {
  await identity(assigned);
  expect((await db.query('SELECT * FROM icp_mining_people')).rows).toEqual([]);
  await expect(append(selectedId, 6)).rejects.toMatchObject({ code: 'P0002' });
  const own = await create(7, ['owned:1']);
  expect((await append(own.list.id, 8, ['owned:2'])).added_count).toBe(1);
  await identity(outsider);
  await expect(create(9)).rejects.toMatchObject({ code: '42501' });
  await identity(owner, 'update');
  await expect(append(selectedId, 10)).rejects.toMatchObject({ code: '42501' });
  await identity(owner, 'insert');
  await expect(create(11)).rejects.toMatchObject({ code: '42501' });
  await identity(owner, '', true);
  await expect(create(12)).rejects.toMatchObject({ code: '42501' });
  await expect(append(selectedId, 13)).rejects.toMatchObject({ code: '42501' });
  await db.exec('RESET ROLE; SET ROLE anon');
  await expect(create(14)).rejects.toMatchObject({ code: '42501' });
});
test('direct membership/receipt writes denied; invalid IDs fail atomically and owner cannot be forged', async () => {
  await identity();
  await expect(db.query('INSERT INTO icp_mining_people(icp_mining_id,site_id,person_id,created_by) VALUES ($1,$2,$3,$4)', [selectedId, site, 'forged', outsider])).rejects.toMatchObject({ code: '42501' });
  await expect(db.query('SELECT * FROM finder_selected_list_requests')).rejects.toMatchObject({ code: '42501' });
  for (const ids of [[], Array(101).fill('abc'), ['bad/id'], [null], ['a'.repeat(257)]]) {
    await expect(create(15, ids as string[])).rejects.toMatchObject({ code: '22023' });
  }
  await expect(db.query('UPDATE icp_mining SET user_id=$1 WHERE id=$2', [outsider, selectedId])).rejects.toMatchObject({ code: '42501' });
});
test('same migration is mirrored byte-for-byte in web repository', () => {
  expect(readFileSync(resolve(migration), 'utf8')).toBe(readFileSync(resolve('../market-fit', migration), 'utf8'));
});

test('queued concurrent retries share one create receipt and append duplicate IDs once', async () => {
  await identity();
  const [first, retry] = await Promise.all([create(20, ['concurrent:1']), create(20, ['concurrent:1'])]);
  expect(first).toEqual(retry);
  const [a, b] = await Promise.all([
    append(first.list.id, 21, ['concurrent:2']), append(first.list.id, 22, ['concurrent:2']),
  ]);
  expect(a.added_count + b.added_count).toBe(1);
  expect((await db.query('SELECT * FROM icp_mining_people WHERE icp_mining_id=$1', [first.list.id])).rows).toHaveLength(2);
});

test('membership failure rolls back placeholder, mining row and receipt together', async () => {
  await db.exec(`RESET ROLE;
    CREATE FUNCTION test_member_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
    CREATE TRIGGER test_member_failure BEFORE INSERT ON icp_mining_people FOR EACH ROW EXECUTE FUNCTION test_member_failure();`);
  const before = (await db.query<any>('SELECT (SELECT count(*) FROM icp_mining) AS mining,(SELECT count(*) FROM role_queries) AS queries,(SELECT count(*) FROM finder_selected_list_requests) AS receipts')).rows[0];
  await identity();
  await expect(create(23, ['rollback:1'])).rejects.toMatchObject({ code: 'P0001' });
  await db.exec('RESET ROLE; DROP TRIGGER test_member_failure ON icp_mining_people; DROP FUNCTION test_member_failure()');
  const after = (await db.query<any>('SELECT (SELECT count(*) FROM icp_mining) AS mining,(SELECT count(*) FROM role_queries) AS queries,(SELECT count(*) FROM finder_selected_list_requests) AS receipts')).rows[0];
  expect(after).toEqual(before);
});