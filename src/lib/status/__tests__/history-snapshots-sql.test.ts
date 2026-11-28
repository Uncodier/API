import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeHealthStatus } from '@/lib/status/observation';

const SINCE = '2026-09-20T12:00:00.000Z';
const UNTIL = '2026-10-20T12:00:00.000Z';
const NAMES = ['get_system_status_daily_snapshot', 'get_system_status_observed_sla_snapshot'];
const checks: Record<string, unknown>[] = [
  {}, { verification: 'configuration' }, { verification: 'unverified' },
  { verification: 'partial', observedFailure: false }, { verification: 'partial', observedFailure: true },
  { telemetryFound: false }, { telemetryFound: 'false' },
  { routesRegistered: true, sideEffectSafe: true },
  { providers: { ready: { configured: true, verification: 'configuration', liveProbe: false } } },
  { inheritedProviders: [{ configured: true, verification: 'configuration', liveProbe: false }] },
  { providers: null, inheritedProviders: { ready: { configured: true, verification: 'configuration', liveProbe: false } } },
  { providers: { missing: { configured: false } } },
  { providers: [{ configured: true, verification: 'inference', liveProbe: true }] },
  { httpStatus: 499.99 }, { httpStatus: 500.01 }, { httpStatus: true },
  { routes: [{ status: '503' }], sampleRoutes: [{ status: 403 }], verification: 'configuration' },
  { httpStatus: 200, continuationHttpStatus: 429 }, { sampleRoutes: [{ status: 401.1 }] },
  { httpStatus: '404' }, { continuationHttpStatus: 404 }, { routes: [{ status: 0 }, null] },
  { sampleRoutes: [{ status: 429 }] }, { routes: 'invalid' },
  ...[0, 200, 204, 302, 400, 401, 403, 404, 429, 500, 503].map((httpStatus) => ({ httpStatus })),
  { verification: 'configuration', httpStatus: 404 }, { telemetryFound: false, routes: [{ status: 500 }] },
];
const fixtures = ['up', 'degraded', 'down', 'skipped', 'invalid'].flatMap((status) =>
  checks.map((evidence) => ({ status, checks: evidence })));
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261027020000_status_history_snapshots.sql'), 'utf8');

const optimization = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261128035000_status_snapshot_normalization.sql'), 'utf8');

type Counts = Record<string, string | number>;
type SnapshotResult = { rows: Array<{ snapshot: Counts[] }>; baseline: Counts[] };
type Security = {
  proname: string; prosecdef: boolean; proconfig: string[]; provolatile: string;
  language: string; return_type: string; proretset: boolean;
  public_execute: boolean; anon: boolean; authenticated: boolean; service: boolean;
};

// Like history-aggregates.test.ts, isolate PGlite's ESM/WASM runtime from ts-jest.
describe('history snapshot SQL (offline PGlite)', () => {
  let result: {
    daily: SnapshotResult; sla: SnapshotResult; empty: Array<{ snapshot: unknown[] }>;
    statesBefore: string[]; statesAfter: string[]; security: Security[];
    denied: string[]; invokerDenied: string[]; revised: Counts[][];
    helperSecurity: Security; malformedBefore: string[]; malformedAfter: string[];
  };

  beforeAll(() => {
    const oldMigration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261020195500_status_observed_history.sql'), 'utf8');
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const { oldMigration, migration, optimization, fixtures, since, until, names } = JSON.parse(input);
      const db = new PGlite();
      try {
        await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE public.system_status (system_key text, status text, created_at timestamptz, health_payload jsonb); GRANT SELECT ON public.system_status TO service_role;');
        await db.exec(oldMigration);
        const states = async () => (await db.query(
          "SELECT public.status_observed_state(f->>'status', f->'checks') AS state FROM jsonb_array_elements($1::jsonb) AS f",
          [JSON.stringify(fixtures)]
        )).rows.map(r => r.state);
        const malformed = async () => (await db.query(
          \`SELECT public.status_observed_state('degraded', v) AS state FROM unnest(ARRAY[NULL, 'null'::jsonb, 'true', '500', '\"httpStatus\"', '[\"routes\"]']) AS x(v)\`
        )).rows.map(r => r.state);
        const malformedBefore = await malformed();
        const statesBefore = await states();
        await db.exec(migration);
        await db.exec(optimization);
        const malformedAfter = await malformed();
        const statesAfter = await states();
        await db.exec("SET TIME ZONE 'America/Los_Angeles'");
        await db.query(
          "INSERT INTO public.system_status SELECT 'norm_' || lpad(i::text, 3, '0'), f->>'status', $2::timestamptz, jsonb_build_object('checks', f->'checks') FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(f,i)",
          [JSON.stringify(fixtures), until]
        );
        await db.exec("INSERT INTO public.system_status SELECT 'system_' || lpad(i::text, 3, '0'), 'up', d, null FROM generate_series(1,601) AS i CROSS JOIN (VALUES ('2026-10-19T23:30:00Z'::timestamptz), ('2026-10-20T00:30:00Z'::timestamptz)) AS dates(d) ORDER BY i DESC, d DESC");

        const functions = (await db.query(
          "SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile, l.lanname AS language, p.prorettype::regtype::text AS return_type, p.proretset, EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute, has_function_privilege('anon',p.oid,'EXECUTE') AS anon, has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated, has_function_privilege('service_role',p.oid,'EXECUTE') AS service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname = ANY($1::text[]) ORDER BY p.proname",
          [[...names, 'status_observed_state']]
        )).rows;
        const helperSecurity = functions.find(f => f.proname === 'status_observed_state');
        const security = functions.filter(f => names.includes(f.proname));
        const denied = [];
        for (const role of ['anon', 'authenticated']) {
          await db.exec('SET ROLE ' + role);
          for (const name of names) {
            try { await db.query('SELECT public.' + name + '($1,$2)', [since,until]); }
            catch (error) { if (error.code !== '42501') throw error; denied.push(role + ':' + name); }
          }
          await db.exec('RESET ROLE');
        }
        await db.exec('SET ROLE service_role');
        const snapshot = async (name, order) => ({
          rows: (await db.query('SELECT public.' + name + '_snapshot($1,$2) AS snapshot', [since,until])).rows,
          baseline: (await db.query('SELECT to_jsonb(r) AS row FROM public.' + name + '($1,$2) r ORDER BY ' + order, [since,until])).rows.map(r => r.row),
        });
        const daily = await snapshot('get_system_status_daily', 'day, system_key');
        const sla = await snapshot('get_system_status_observed_sla', 'system_key');
        const empty = [];
        for (const name of names) {
          empty.push(...(await db.query('SELECT public.' + name + '($1,$2) AS snapshot', ['2027-01-01', '2027-01-02'])).rows);
        }
        // Refresh the same historical interval after a late arrival in a closed UTC day.
        // The final day is partial: include the exact cutoff but nothing later.
        await db.exec('RESET ROLE');
        await db.exec("INSERT INTO public.system_status VALUES ('late', 'up', '2026-10-13T12:00:00Z', null), ('late', 'degraded', '2026-10-20T12:00:00Z', null), ('late', 'down', '2026-10-20T12:00:00.000001Z', null)");
        await db.exec('SET ROLE service_role');
        const revised = [];
        for (const name of names) {
          const { rows } = await db.query('SELECT public.' + name + '($1,$2) AS snapshot', [since,until]);
          revised.push(rows[0].snapshot.filter(r => r.system_key === 'late'));
        }
        await db.exec('RESET ROLE; REVOKE SELECT ON public.system_status FROM service_role; SET ROLE service_role');
        const invokerDenied = [];
        for (const name of names) {
          try { await db.query('SELECT public.' + name + '($1,$2)', [since,until]); }
          catch (error) { if (error.code !== '42501') throw error; invokerDenied.push(name); }
        }
        console.log(JSON.stringify({ daily, sla, revised, empty, statesBefore, statesAfter, malformedBefore, malformedAfter, helperSecurity, security, denied, invokerDenied }));
      } finally { await db.close(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      input: JSON.stringify({ oldMigration, migration, optimization, fixtures, since: SINCE, until: UNTIL, names: NAMES }),
    });
    if (child.status !== 0) throw new Error(`Offline SQL fixture failed: ${child.stderr || child.error}`);
    result = JSON.parse(child.stdout);
  }, 60000);

  it('preserves more than 500 grouped rows in each single ordered jsonb value', () => {
    for (const snapshot of [result.daily, result.sla]) {
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0].snapshot.length).toBeGreaterThan(500);
      expect(snapshot.rows[0].snapshot).toEqual(snapshot.baseline);
    }
    expect(result.daily.rows[0].snapshot).toHaveLength(1202 + fixtures.length);
    expect(result.sla.rows[0].snapshot).toHaveLength(601 + fixtures.length);
    expect(result.daily.rows[0].snapshot[0]).toMatchObject({ day: '2026-10-19', system_key: 'system_001' });
    expect(result.daily.rows[0].snapshot.at(-1)).toMatchObject({ day: '2026-10-20', system_key: 'system_601' });
  });

  it('includes late evidence on refresh without rounding the final day or rolling windows', () => {
    expect(result.revised[0]).toEqual([
      expect.objectContaining({ day: '2026-10-13', check_count: 1, up_check_count: 1 }),
      expect.objectContaining({ day: '2026-10-20', check_count: 1, degraded_check_count: 1 }),
    ]);
    expect(result.revised[1]).toEqual([{
      system_key: 'late', total_24h: 1, up_24h: 0, total_7d: 2, up_7d: 1, total_30d: 2, up_30d: 1,
    }]);
  });

  it('returns [] rather than null when there are no observations', () => {
    expect(result.empty).toEqual([{ snapshot: [] }, { snapshot: [] }]);
  });

  it('leaves normalization unchanged and preserves normalized counts in both snapshots', () => {
    const expected = fixtures.map(f => normalizeHealthStatus(f.status, f.checks));
    expect(result.malformedBefore).toEqual(Array(6).fill('degraded'));
    expect(result.malformedAfter).toEqual(result.malformedBefore);
    expect(result.statesBefore).toEqual(expected);
    expect(result.statesAfter).toEqual(expected);
    expected.forEach((state, i) => {
      const system_key = `norm_${String(i + 1).padStart(3, '0')}`;
      expect(result.daily.rows[0].snapshot.find(r => r.system_key === system_key)).toMatchObject({
        check_count: 1, observed_check_count: Number(state !== 'skipped'), up_check_count: Number(state === 'up'),
        degraded_check_count: Number(state === 'degraded'), down_check_count: Number(state === 'down'),
        skipped_check_count: Number(state === 'skipped'),
      });
      expect(result.sla.rows[0].snapshot.find(r => r.system_key === system_key)).toMatchObject({
        total_24h: Number(state !== 'skipped'), up_24h: Number(state === 'up'),
        total_7d: Number(state !== 'skipped'), up_7d: Number(state === 'up'),
        total_30d: Number(state !== 'skipped'), up_30d: Number(state === 'up'),
      });
    });
  });

  it('restricts both stable SQL invoker functions to service_role with an empty search_path', () => {
    expect(result.helperSecurity).toMatchObject({
      prosecdef: false, provolatile: 'i', return_type: 'text', public_execute: false,
      anon: false, authenticated: false, service: true, proconfig: ['search_path=""'],
    });
    expect(result.security.map(s => s.proname)).toEqual(NAMES);
    for (const security of result.security) {
      expect(security).toMatchObject({
        prosecdef: false, provolatile: 's', language: 'sql', return_type: 'jsonb', proretset: false,
        public_execute: false, anon: false, authenticated: false, service: true, proconfig: ['search_path=""'],
      });
    }
    expect(result.denied).toEqual(['anon', 'authenticated'].flatMap(role => NAMES.map(name => `${role}:${name}`)));
    expect(result.invokerDenied).toEqual(NAMES);
    expect(migration).toMatch(/BEGIN;[\s\S]*SET LOCAL lock_timeout = '5s';[\s\S]*SET LOCAL statement_timeout = '30s';[\s\S]*COMMIT;/);
  });
});
