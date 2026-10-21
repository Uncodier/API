import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mockRpc = jest.fn();
const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: mockRpc, from: mockFrom } }));
jest.mock('@/lib/status/handler-registry', () => ({ getHandlerSystemKeys: () => ['ai_text', 'notifications'] }));

import { getDailyStatusCounts, getObservedSlaCounts, type DailyStatusCounts } from '@/lib/status/history-aggregates';
import { getSystemTimelines } from '@/lib/status/get-system-timelines';
import { normalizeHealthStatus } from '@/lib/status/observation';

const SINCE = '2026-09-20T12:00:00.000Z';
const UNTIL = '2026-10-20T12:00:00.000Z';

const daily = (overrides: Partial<DailyStatusCounts> = {}): DailyStatusCounts => ({
  system_key: 'ai_text', day: '2026-10-20', check_count: 10, observed_check_count: 8,
  up_check_count: 6, degraded_check_count: 1, down_check_count: 1, skipped_check_count: 2, ...overrides,
});

function mockPages(rows: unknown[], cap = 500) {
  const queries: Array<{ order: jest.Mock; range: jest.Mock }> = [];
  mockRpc.mockImplementation(() => {
    const query = {
      order: jest.fn().mockReturnThis(),
      range: jest.fn(async (start: number, end: number) => ({ data: rows.slice(start, Math.min(end + 1, start + cap)), error: null })),
    };
    queries.push(query);
    return query;
  });
  return queries;
}

describe('compact status history loaders', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(UNTIL));
    mockPages([]);
  });
  afterEach(() => jest.useRealTimers());

  it('exhausts daily counts despite a short server cap, using fixed bounds and deterministic order', async () => {
    const rows = Array.from({ length: 1101 }, (_, i) => daily({ system_key: `system_${i}` }));
    const queries = mockPages(rows, 137);
    expect(await getDailyStatusCounts(SINCE, UNTIL)).toEqual(rows);
    expect(queries.map((query) => query.range.mock.calls[0][0])).toEqual([0, 137, 274, 411, 548, 685, 822, 959, 1096, 1101]);
    for (const query of queries) {
      expect(query.order.mock.calls).toEqual([['day', { ascending: true }], ['system_key', { ascending: true }]]);
      const [start, end] = query.range.mock.calls[0];
      expect(end - start + 1).toBe(500);
    }
    for (const [name, args] of mockRpc.mock.calls) {
      expect(name).toBe('get_system_status_daily');
      expect(args).toEqual({ p_since: SINCE, p_until: UNTIL });
    }
  });

  it('loads SLA counts with numeric conversion for JSON bigint strings', async () => {
    mockPages([{ system_key: 'ai_text', total_24h: '10', up_24h: '8', total_7d: '20', up_7d: '18', total_30d: '30', up_30d: '28' }], 1);
    expect(await getObservedSlaCounts(SINCE, UNTIL)).toEqual([
      { system_key: 'ai_text', total_24h: 10, up_24h: 8, total_7d: 20, up_7d: 18, total_30d: 30, up_30d: 28 },
    ]);
    expect(mockRpc).toHaveBeenCalledWith('get_system_status_observed_sla', { p_since: SINCE, p_until: UNTIL });
  });

  it.each(['PGRST202', '42883'])('returns null only for missing RPC code %s', async (code) => {
    mockRpc.mockReturnValue({ order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: null, error: { code, message: 'function missing' } }) });
    expect(await getDailyStatusCounts(SINCE, UNTIL)).toBeNull();
    expect(await getObservedSlaCounts(SINCE, UNTIL)).toBeNull();
  });

  it.each(['42501', 'PGRST301', 'XX000'])('propagates non-missing database failure %s', async (code) => {
    mockRpc.mockReturnValue({ order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: null, error: { code, message: 'query failed' } }) });
    await expect(getDailyStatusCounts(SINCE, UNTIL)).rejects.toThrow('query failed');
    await expect(getObservedSlaCounts(SINCE, UNTIL)).rejects.toThrow('query failed');
  });

  it('rejects later-page failure rather than returning partial aggregates', async () => {
    mockPages([daily()], 1);
    mockRpc.mockImplementationOnce(() => ({ order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: [daily()], error: null }) }));
    mockRpc.mockImplementationOnce(() => ({ order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: null, error: { code: 'XX000', message: 'later failure' } }) }));
    await expect(getDailyStatusCounts(SINCE, UNTIL)).rejects.toThrow('later failure');
  });

  it.each([-1, 1.5, null, 'bad', '9007199254740992'])('rejects invalid/unsafe count %s', async (count) => {
    mockPages([{ ...daily(), check_count: count }]);
    await expect(getDailyStatusCounts(SINCE, UNTIL)).rejects.toThrow('invalid check_count');
  });

  it('does not treat null data or transport failures as unavailable migration', async () => {
    mockRpc.mockReturnValue({ order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(getDailyStatusCounts(SINCE, UNTIL)).rejects.toThrow('returned no data');
    mockRpc.mockImplementation(() => { throw new Error('network failure'); });
    await expect(getObservedSlaCounts(SINCE, UNTIL)).rejects.toThrow('network failure');
  });

  it('rejects contradictory aggregate counts instead of displaying invalid uptime', async () => {
    mockPages([daily({ observed_check_count: 1 })]);
    await expect(getDailyStatusCounts(SINCE, UNTIL)).rejects.toThrow('inconsistent counts');
    mockPages([{ system_key: 'ai_text', total_24h: 1, up_24h: 2, total_7d: 2, up_7d: 2, total_30d: 2, up_30d: 2 }]);
    await expect(getObservedSlaCounts(SINCE, UNTIL)).rejects.toThrow('inconsistent counts');
  });

  it('builds the same worst-day/check-weighted timeline directly from compact counts', async () => {
    mockPages([daily(), daily({ day: '2026-10-19', check_count: 2, observed_check_count: 2, up_check_count: 2, degraded_check_count: 0, down_check_count: 0, skipped_check_count: 0 })], 1);
    const [timeline, empty] = await getSystemTimelines(2);
    expect(timeline.days).toEqual([
      { date: '2026-10-19', status: 'up', checkCount: 2, observedCheckCount: 2, upCheckCount: 2 },
      { date: '2026-10-20', status: 'down', checkCount: 10, observedCheckCount: 8, upCheckCount: 6 },
    ]);
    expect(timeline.uptimePercent).toBe(80);
    expect(empty.uptimePercent).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([
    [0, 1, 0, 1, 'degraded'], [0, 0, 1, 1, 'up'], [0, 0, 0, 2, 'skipped'],
  ])('resolves compact worst status from counts', async (down, degraded, up, skipped, status) => {
    mockPages([daily({ check_count: down + degraded + up + skipped, observed_check_count: down + degraded + up,
      down_check_count: down, degraded_check_count: degraded, up_check_count: up, skipped_check_count: skipped })]);
    const [timeline] = await getSystemTimelines(1);
    expect(timeline.days[0].status).toBe(status);
    expect(timeline.uptimePercent).toBe(status === 'skipped' ? null : status === 'up' ? 100 : 0);
  });

  it('uses raw history only when the RPC is missing, not when counts are empty or fail', async () => {
    mockRpc.mockReturnValue({ order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not installed' } }) });
    mockFrom.mockReturnValue({ select: jest.fn().mockReturnThis(), gte: jest.fn().mockReturnThis(), lte: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: [], error: null }) });
    expect(await getSystemTimelines(1)).toHaveLength(2);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    mockFrom.mockClear();
    mockPages([]);
    expect(await getSystemTimelines(1)).toHaveLength(2);
    expect(mockFrom).not.toHaveBeenCalled();
    mockRpc.mockReturnValue({ order: jest.fn().mockReturnThis(), range: jest.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } }) });
    await expect(getSystemTimelines(1)).rejects.toThrow('denied');
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('unapplied SQL migration contract (offline PGlite)', () => {
  it('matches the shared normalizer, UTC/time windows, compact counts and service-role-only privileges', () => {
    const checks: Record<string, unknown>[] = [
      {}, { verification: 'configuration' }, { verification: 'unverified' },
      { verification: 'partial', observedFailure: false }, { verification: 'partial', observedFailure: true },
      { verification: 'partial' }, { telemetryFound: false }, { telemetryFound: 'false' },
      { routesRegistered: true, sideEffectSafe: true }, { routesRegistered: true, sideEffectSafe: false },
      { providers: { ready: { configured: true, verification: 'configuration', liveProbe: false } } },
      { inheritedProviders: { ready: { configured: true, verification: 'configuration', liveProbe: false } } },
      { providers: null, inheritedProviders: { ready: { configured: true, verification: 'configuration', liveProbe: false } } },
      { providers: {}, inheritedProviders: { ready: { configured: true, verification: 'configuration', liveProbe: false } } },
      { providers: { missing: { configured: false, verification: 'configuration', liveProbe: false } } },
      { providers: { ready: { configured: true, verification: 'configuration', liveProbe: false }, failed: { configured: true, verification: 'inference', liveProbe: false } } },
      { providers: [{ configured: true, verification: 'configuration', liveProbe: false }] },
      { providers: { incomplete: { configured: true, verification: 'configuration' } } },
      { providers: false, inheritedProviders: { ready: { configured: true, verification: 'configuration', liveProbe: false } } },
      { httpStatus: '404' }, { continuationHttpStatus: 404 }, { routes: [{ status: 0 }, null] },
      { sampleRoutes: [{ status: 429 }] }, { routes: 'invalid', sampleRoutes: [{ status: 200 }] },
      ...[0, 200, 204, 302, 400, 401, 403, 404, 429, 500, 503].map((httpStatus) => ({ httpStatus })),
      { verification: 'configuration', httpStatus: 404 }, { telemetryFound: false, routes: [{ status: 500 }] },
    ];
    const fixtures = ['up', 'degraded', 'down', 'skipped', 'invalid'].flatMap((status) => checks.map((evidence) => ({ status, checks: evidence })));
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261020195500_status_observed_history.sql'), 'utf8');
    const script = `
      import { PGlite } from '@electric-sql/pglite';
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const { migration, fixtures, since, until } = JSON.parse(input);
      const db = new PGlite();
      try {
        await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE public.system_status (system_key text, status text, created_at timestamptz, health_payload jsonb); GRANT SELECT ON public.system_status TO service_role;');
        await db.exec(migration);
        const states = await db.query("SELECT public.status_observed_state(f->>'status', f->'checks') AS state FROM jsonb_array_elements($1::jsonb) AS f", [JSON.stringify(fixtures)]);
        await db.exec("SET TIME ZONE 'America/Los_Angeles'; INSERT INTO public.system_status VALUES ('ai_text','up','2026-10-20T00:01:00Z',null), ('ai_text','degraded','2026-10-20T01:00:00Z','{\\"checks\\":{\\"verification\\":\\"configuration\\"}}'), ('ai_text','up','2026-10-13T12:00:00Z',null), ('ai_text','down','2026-09-20T12:00:00Z',null), ('ai_text','down','2026-09-20T11:59:59Z',null), ('ai_text','down','2026-10-20T12:00:01Z',null), ('notifications','skipped','2026-10-20T02:00:00Z',null); INSERT INTO public.system_status SELECT 'ai_text','up','2026-10-20T11:00:00Z',null FROM generate_series(1,1001);");
        const daily = await db.query('SELECT * FROM public.get_system_status_daily($1,$2)', [since,until]);
        const sla = await db.query('SELECT * FROM public.get_system_status_observed_sla($1,$2)', [since,until]);
        const security = await db.query("SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon',p.oid,'EXECUTE') AS anon, has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated, has_function_privilege('service_role',p.oid,'EXECUTE') AS service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('status_observed_state','get_system_status_daily','get_system_status_observed_sla') ORDER BY p.proname");
        await db.exec('SET ROLE anon');
        let denied = false; try { await db.query('SELECT * FROM public.get_system_status_daily($1,$2)',[since,until]); } catch(error) { denied = error.code === '42501'; }
        await db.exec('RESET ROLE; SET ROLE service_role');
        const allowed = await db.query('SELECT * FROM public.get_system_status_observed_sla($1,$2)',[since,until]);
        console.log(JSON.stringify({ states: states.rows.map(r=>r.state), daily:daily.rows.map(r=>({...r,day:r.day.toISOString().slice(0,10)})), sla:sla.rows, security:security.rows, denied, allowed:allowed.rows }));
      } finally { await db.close(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), input: JSON.stringify({ migration, fixtures, since: SINCE, until: UNTIL }), encoding: 'utf8', timeout: 60000,
    });
    if (child.status !== 0) throw new Error(`Offline SQL fixture failed: ${child.stderr || child.error}`);
    const result = JSON.parse(child.stdout);
    expect(result.states).toEqual(fixtures.map((fixture) => normalizeHealthStatus(fixture.status, fixture.checks)));
    expect(result.daily).toEqual([
      { system_key: 'ai_text', day: '2026-09-20', check_count: 1, observed_check_count: 1, up_check_count: 0, degraded_check_count: 0, down_check_count: 1, skipped_check_count: 0 },
      { system_key: 'ai_text', day: '2026-10-13', check_count: 1, observed_check_count: 1, up_check_count: 1, degraded_check_count: 0, down_check_count: 0, skipped_check_count: 0 },
      { system_key: 'ai_text', day: '2026-10-20', check_count: 1003, observed_check_count: 1002, up_check_count: 1002, degraded_check_count: 0, down_check_count: 0, skipped_check_count: 1 },
      { system_key: 'notifications', day: '2026-10-20', check_count: 1, observed_check_count: 0, up_check_count: 0, degraded_check_count: 0, down_check_count: 0, skipped_check_count: 1 },
    ]);
    expect(result.sla).toEqual([
      { system_key: 'ai_text', total_24h: 1002, up_24h: 1002, total_7d: 1003, up_7d: 1003, total_30d: 1004, up_30d: 1003 },
      { system_key: 'notifications', total_24h: 0, up_24h: 0, total_7d: 0, up_7d: 0, total_30d: 0, up_30d: 0 },
    ]);
    expect(result.allowed).toEqual(result.sla);
    expect(result.denied).toBe(true);
    expect(result.security).toHaveLength(3);
    for (const security of result.security) {
      expect(security).toMatchObject({ prosecdef: false, anon: false, authenticated: false, service: true });
      expect(security.proconfig).toEqual(['search_path=""']);
    }
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|ALTER TABLE)\s+public\.system_status/i);
  }, 60000);
});