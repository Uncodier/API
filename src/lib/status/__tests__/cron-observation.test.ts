import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TelemetryRecord } from '@/lib/status/telemetry';
import type { CronJobKey } from '@/lib/status/cron-observation';

const recordTelemetry = jest.fn<(...args: unknown[]) => Promise<void>>();
const getLatestTelemetry = jest.fn<(key: string, hours?: number) => Promise<TelemetryRecord | null>>();
jest.unstable_mockModule('@/lib/status/telemetry', () => ({
  recordTelemetry, getLatestTelemetry,
  REDIS_TELEMETRY_KEYS: { recordings: 'redis_recording_queue', tracking: 'redis_tracking_queue' },
}));

// All route dependencies are inert. Importing and rejecting unauthorized cron
// requests must never initialize a real database, SDK, workflow or billing call.
const businessCall = jest.fn<(...args: unknown[]) => Promise<unknown>>(() => {
  throw new Error('Business work is forbidden in route authentication tests');
});
const mocks: Record<string, Record<string, unknown>> = {
  '@/lib/services/catalog-search/dispatch': { startCatalogIndex: businessCall },
  '@/lib/services/cron/market-fit-dispatch': { dispatchMarketFitWorker: businessCall },
  'workflow/api': { start: businessCall },
  '@/app/api/cron/requirements-apps/workflow': { runCronAppsWorkflow: businessCall },
  '@/app/api/cron/requirements-apps/scheduler-config': { getMaxConcurrentRequirementRuns: businessCall, getRequirementEvaluationLimit: businessCall },
  '@/lib/harness/requirement-scheduler': { dueScheduledRequirements: businessCall, claimRequirementRun: businessCall, finishRequirementCycle: businessCall },
  '@vercel/sandbox': { Sandbox: { list: businessCall } },
  '@/lib/services/sandbox-persisted-snapshot': { deleteSnapshotQuiet: businessCall },
  '@/lib/services/sandbox-stop': { stopSandboxQuiet: businessCall },
  '@/lib/services/billing/sandbox-billing': { reconcileSandboxBilling: businessCall, retireSandboxBilling: businessCall },
  '@/lib/services/sandbox-missing-snapshot': { isSandboxNotFoundError: businessCall },
  '@/lib/services/billing/sandbox-housekeeping-list': { listHousekeepingSandboxes: businessCall },
  '@/lib/services/billing/sandbox-housekeeping-db': { housekeepingRows: businessCall },
  '@/lib/services/sandbox-sdk': { sandboxSdkMajor: businessCall },
  '@/lib/services/sandbox-lifecycle': { deleteSandboxAndOrphans: businessCall },
  '@/lib/services/session-event-retention': { runSessionEventRetention: businessCall },
  '@/lib/services/session-recording-queue': { drainRecordingMetadataQueue: businessCall },
  '@/lib/services/tracking-event-queue': { drainTrackingEventQueue: businessCall },
  '@/lib/database/supabase-client': { supabaseAdmin: { from: businessCall } },
  '@/lib/services/workflow-robot/materialize': { materializeRunFromGraph: businessCall },
  '@/lib/services/workflow-robot/run-plan': { runWorkflowPlan: businessCall },
  '@/app/api/cron/workflows/workflow': { executeScheduledWorkflow: businessCall },
  '@/lib/services/workflow-robot/cron-window': { isCronDueInWindow: businessCall, WORKFLOW_CRON_WINDOW_MS: 60_000 },
  '@/lib/timezone': { DEFAULT_TIMEZONE: 'UTC', normalizeTimezone: businessCall, resolveClientTimezone: businessCall },
  '@/lib/services/robot-instance/assistant-respawn': { countRecentRespawns: businessCall, evaluateInstanceStall: businessCall, LOOKBACK_MS: 60_000, spawnSilentContinueWorkflow: businessCall },
  '@/lib/services/workflow-robot/plan-ownership': { isRespawnManagedPlan: businessCall, isWorkflowManagedPlan: businessCall },
  '@/lib/services/robot-instance/pending-work': { processPendingWorkTick: businessCall },
  '@/lib/services/record-embedding-worker': { processRecordEmbeddingsById: businessCall },
};
for (const [name, exports] of Object.entries(mocks)) jest.unstable_mockModule(name, () => exports);

const { CRON_JOBS, cronTelemetryKey, withCronObservation } = await import('@/lib/status/cron-observation');
const { cronHandler } = await import('@/lib/status/handlers/cron');
const { isCriticalFailure } = await import('@/lib/status/types');
const routes = await Promise.all(CRON_JOBS.map(async job => ({
  ...job,
  GET: (await import(`@/app${job.path}/route`)).GET as (request: Request) => Promise<Response>,
})));

const originalEnv = process.env;
const originalFetch = globalThis.fetch;
const fetchMock = jest.fn<typeof fetch>(() => { throw new Error('Live fetch forbidden'); });
let secret: string;

function request(authorization: string | null = `Bearer ${secret}`): Request {
  const headers = new Headers();
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request(new URL('/api/cron/test', 'https://example.test'), { headers });
}

function receipt(status: TelemetryRecord['status'] = 'up', ageMs = 0): TelemetryRecord {
  return { status, message: 'Synthetic execution receipt', latency_ms: 12, created_at: new Date(Date.now() - ageMs).toISOString() };
}

beforeEach(() => {
  secret = randomBytes(32).toString('hex');
  process.env = { NODE_ENV: 'test', CRON_SECRET: secret, CATALOG_INDEXING_ENABLED: 'true' };
  recordTelemetry.mockReset().mockResolvedValue(undefined);
  getLatestTelemetry.mockReset().mockResolvedValue(null);
  businessCall.mockReset().mockImplementation(() => { throw new Error('Business work is forbidden unless explicitly stubbed'); });
  fetchMock.mockClear();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('scheduled registry and actual route authentication (offline)', () => {
  it('matches every Vercel cron except the self-monitor, with a minimal wrapper', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'));
    const configured = config.crons.filter((job: { path: string }) => job.path !== '/api/cron/system-status');
    expect(CRON_JOBS).toHaveLength(12);
    expect(CRON_JOBS.map(({ path, schedule }) => ({ path, schedule }))).toEqual(configured);
    expect(new Set(CRON_JOBS.map(job => cronTelemetryKey(job.key))).size).toBe(12);
    for (const job of CRON_JOBS) {
      const source = readFileSync(resolve(process.cwd(), `src/app${job.path}/route.ts`), 'utf8');
      expect(source).toContain(`export const GET = withCronObservation('${job.key}', runCron)`);
      expect(job.freshnessMs).toBe(job.cadenceMs === 86_400_000 ? 93_600_000 : job.cadenceMs * 3);
    }
  });

  it.each(routes)('$key rejects absent/blank secrets and invalid auth without business or telemetry calls', async ({ GET }) => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = value;
      for (const authorization of [null, 'Bearer undefined', 'Bearer', `Bearer ${secret}`]) {
        expect((await GET(request(authorization))).status).toBe(401);
      }
    }
    process.env.CRON_SECRET = secret;
    for (const authorization of [null, `Bearer ${randomBytes(32).toString('hex')}`, `Basic ${secret}`]) {
      expect((await GET(request(authorization))).status).toBe(401);
    }
    expect(businessCall).not.toHaveBeenCalled();
    expect(recordTelemetry).not.toHaveBeenCalled();
  });
});

describe('execution/accepted dispatch receipts', () => {
  it('the actual catalog route skips disabled work with no business call or receipt', async () => {
    process.env.CATALOG_INDEXING_ENABLED = 'false';
    const response = await routes.find(job => job.key === 'catalog-index')!.GET(request());
    expect(await response.json()).toEqual({ success: true, disabled: true });
    expect(businessCall).not.toHaveBeenCalled();
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it.each(['catalog-index', 'marketplace', 'credit-auto-top-up'] as const)('the actual %s route emits its own receipt after stubbed dispatch only', async key => {
    const body = key === 'catalog-index' ? { success: true, workflow_id: randomBytes(12).toString('hex') }
      : key === 'marketplace' ? { worker: key, refreshed: 1, unavailable: 0 }
      : { worker: key, results: [], deferred: 0 };
    businessCall.mockResolvedValue(key === 'catalog-index' ? body : Response.json(body));
    const response = await routes.find(job => job.key === key)!.GET(request());
    expect(await response.json()).toEqual(body);
    expect(businessCall).toHaveBeenCalledTimes(1);
    expect(recordTelemetry).toHaveBeenCalledWith(cronTelemetryKey(key), 'up', expect.any(String), expect.any(Number));
  });

  it.each(['session-recordings', 'tracking-events'] as const)('the actual %s route preserves its existing queue telemetry and adds a cron receipt', async key => {
    const result = { state: 'empty', chunks: 0, events: 0, messages: 0, deadLetters: 0, remaining: 0 };
    businessCall.mockResolvedValue(result);
    const response = await routes.find(job => job.key === key)!.GET(request());
    expect(await response.json()).toEqual({ success: true, result });
    expect(businessCall).toHaveBeenCalledTimes(1);
    expect(recordTelemetry).toHaveBeenCalledTimes(2);
    expect(recordTelemetry.mock.calls[0][0]).toBe(key === 'session-recordings' ? 'redis_recording_queue' : 'redis_tracking_queue');
    expect(recordTelemetry).toHaveBeenLastCalledWith(cronTelemetryKey(key), 'up', expect.any(String), expect.any(Number));
  });

  it.each(CRON_JOBS)('awaits the $key receipt and preserves response identity, body, headers and context', async ({ key }) => {
    const userData = randomBytes(12).toString('hex');
    const response = Response.json({ success: true, results: [], userData }, {
      status: 202, headers: { 'x-existing': 'preserved' },
    });
    const handler = jest.fn(async (_request: Request, context: { existing: boolean }) => {
      expect(context).toEqual({ existing: true });
      return response;
    });
    let release!: () => void;
    recordTelemetry.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const pending = withCronObservation(key, handler)(request(), { existing: true }).then(result => { settled = true; return result; });
    // Wait until the wrapper reaches the emitter, without releasing its promise.
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(recordTelemetry).toHaveBeenCalledWith(cronTelemetryKey(key), 'up', expect.stringContaining('downstream completion unverified'), expect.any(Number));
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe(response);
    expect(response.headers.get('x-existing')).toBe('preserved');
    expect(await response.json()).toMatchObject({ success: true, results: [] });
    expect(JSON.stringify(recordTelemetry.mock.calls)).not.toContain(userData);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('records down on an exception, awaits the receipt and rethrows the original value without leaking it', async () => {
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(16).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/failure');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    const error = new Error(`${url} Bearer ${secret}`);
    let release!: () => void;
    recordTelemetry.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let caught: unknown;
    const pending = withCronObservation('workflows', async () => { throw error; })(request()).catch(value => { caught = value; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(caught).toBeUndefined();
    expect(recordTelemetry).toHaveBeenCalledWith('cron_workflows', 'down', expect.any(String), expect.any(Number));
    release();
    await pending;
    expect(caught).toBe(error);
    const emitted = JSON.stringify(recordTelemetry.mock.calls);
    for (const value of [username, password, token, secret]) expect(emitted).not.toContain(value);
  });

  it.each([500, 503])('classifies HTTP %i as down without inspecting or logging its body', async status => {
    const response = Response.json({ error: secret }, { status });
    const clone = jest.spyOn(response, 'clone');
    expect(await withCronObservation('catalog-index', async () => response)(request())).toBe(response);
    expect(clone).not.toHaveBeenCalled();
    expect(recordTelemetry.mock.calls[0][1]).toBe('down');
    expect(JSON.stringify(recordTelemetry.mock.calls)).not.toContain(secret);
  });

  const failures: Array<[CronJobKey, unknown]> = [
    ['catalog-index', { success: false }],
    ['workflows', { errors: 1 }],
    ['workflows', { results: [{ skipped: 'dispatch unavailable' }] }],
    ['requirements-apps', { results: [{ started: false }] }],
    ['sandbox-housekeeping', { success: true, results: { sandboxErrors: 1, snapshotErrors: 0, billingErrors: 0 } }],
    ['sandbox-housekeeping', { success: true, results: { billingErrors: 2 } }],
    ['session-events', { success: true, result: { storageErrors: 1 } }],
    ['session-recordings', { success: true, result: { deadLetters: 1 } }],
    ['tracking-events', { success: true, result: { deadLetters: 2 } }],
    ['assistant-respawn', { results: [{ status: 'recovery_check_failed' }] }],
    ['assistant-respawn', { results: [{ status: 'skipped_plan_lookup_error' }] }],
    ['pending-work', { results: [{ status: 'error: dispatch failed' }] }],
    ['pending-work', { results: [{ status: 'reverted: dispatch failed' }] }],
    ['pending-work', { results: [{ status: 'claim_failed' }] }],
    ['record-embeddings', { success: false, processed: 1, failed: [{ error: 'embedding unavailable' }] }],
    ['record-embeddings', { failed: 1 }],
    ['marketplace', { refreshed: 1, unavailable: 2 }],
    ['credit-auto-top-up', { results: [{ outcome: 'needs_reconciliation' }], deferred: 0 }],
  ];
  it.each(failures)('%s 200 reports failures as degraded, preserving response data', async (key, body) => {
    const response = Response.json(body);
    expect(await withCronObservation(key, async () => response)(request())).toBe(response);
    expect(recordTelemetry.mock.calls[0][1]).toBe('degraded');
    expect(await response.json()).toEqual(body);
  });

  it.each([
    ['workflows', { results: [{ skipped: 'not_due' }, { skipped: 'duplicate' }, { skipped: 'missing_cron' }] }],
    ['requirements-apps', { results: [], capacityReached: true }],
    ['assistant-respawn', { results: [{ status: 'skipped_workflow_managed' }, { status: 'skipped_no_active_checkpoint' }] }],
    ['pending-work', { results: [{ status: 'sent' }, { status: 'retried' }] }],
    ['record-embeddings', { success: true, processed: 0, failed: [] }],
    ['session-recordings', { success: true, result: { state: 'busy', deadLetters: 0, remaining: 4 } }],
    ['credit-auto-top-up', { results: [{ outcome: 'requires_action' }, { outcome: 'not_eligible' }], deferred: 3 }],
  ] as Array<[CronJobKey, unknown]>)('%s intentional no-op/defer is accepted, not a downstream completion claim', async (key, body) => {
    await withCronObservation(key, async () => Response.json(body))(request());
    expect(recordTelemetry.mock.calls[0][1]).toBe('up');
  });

  it('does not emit a success receipt for disabled catalog work', async () => {
    await withCronObservation('catalog-index', async () => Response.json({ success: true, disabled: true }))(request());
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it.each([401, 403])('does not emit telemetry for handler-level authorization rejection %i', async status => {
    await withCronObservation('workflows', async () => Response.json({ error: 'Unauthorized' }, { status }))(request());
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it('cannot change a response or thrown error when the emitter rejects', async () => {
    recordTelemetry.mockRejectedValue(new Error(secret));
    const response = Response.json({ success: true });
    expect(await withCronObservation('pending-work', async () => response)(request())).toBe(response);
    const error = new Error('Original business failure');
    await expect(withCronObservation('pending-work', async () => { throw error; })(request())).rejects.toBe(error);
  });

  it('bounds cloned JSON inspection and never emits success for malformed/oversized/non-JSON responses', async () => {
    for (const response of [
      new Response('not-json', { headers: { 'content-type': 'application/json' } }),
      Response.json({ data: 'x'.repeat(70_000) }),
      new Response('OK'),
    ]) {
      expect(await withCronObservation('workflows', async () => response)(request())).toBe(response);
      expect(response.bodyUsed).toBe(false);
      await response.text();
    }
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it('bounds waiting for a slow JSON stream while leaving the original readable', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const response = new Response(stream, { headers: { 'content-type': 'application/json' } });
    expect(await withCronObservation('workflows', async () => response)(request())).toBe(response);
    expect(recordTelemetry).not.toHaveBeenCalled();
    controller.enqueue(new TextEncoder().encode('{"success":true}'));
    controller.close();
    expect(await response.json()).toEqual({ success: true });
  });
});

describe('passive per-job freshness and aggregate health', () => {
  it('absent evidence is skipped even with a configured secret, and cannot pass an explicitly selected critical gate', async () => {
    const health = await cronHandler.runCheck();
    expect(health.status).toBe('skipped');
    expect(health.checks).toMatchObject({ verification: 'unverified', observedJobs: 0, unknownJobs: 12, monitorExcluded: true });
    expect(isCriticalFailure(health, ['cron'])).toBe(true);
    expect(isCriticalFailure(health)).toBe(false); // Cron is not a default critical capability.
    expect(getLatestTelemetry).toHaveBeenCalledTimes(12);
    expect(getLatestTelemetry.mock.calls.some(([key]) => key === 'cron' || key.includes('system-status'))).toBe(false);
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it('stale evidence is independently skipped for each cadence, including daily >24h lookback', async () => {
    getLatestTelemetry.mockImplementation(async key => {
      const job = CRON_JOBS.find(job => cronTelemetryKey(job.key) === key)!;
      return receipt('up', job.freshnessMs + 1_000);
    });
    const health = await cronHandler.runCheck();
    expect(health.status).toBe('skipped');
    const jobs = health.checks.jobs as Record<string, Record<string, unknown>>;
    for (const job of CRON_JOBS) {
      expect(jobs[job.key]).toMatchObject({ status: 'skipped', reason: 'stale_receipt', cadenceMs: job.cadenceMs, freshnessMs: job.freshnessMs, lastEventAt: expect.any(String) });
      expect(getLatestTelemetry).toHaveBeenCalledWith(cronTelemetryKey(job.key), job.freshnessMs * 2 / 3_600_000);
    }
    expect(getLatestTelemetry.mock.calls.find(([key]) => key === 'cron_session-events')![1]).toBeGreaterThan(26);
  });

  it('partial healthy coverage degrades rather than hiding missing jobs', async () => {
    getLatestTelemetry.mockImplementation(async key => key === 'cron_marketplace' ? receipt() : null);
    const health = await cronHandler.runCheck();
    expect(health.status).toBe('degraded');
    expect(health.checks).toMatchObject({ verification: 'partial', observedJobs: 1, unknownJobs: 11, observedFailure: false });
    expect(isCriticalFailure(health, ['cron'])).toBe(true);
    expect(health.checks.jobs).toMatchObject({ marketplace: { status: 'up' }, workflows: { status: 'skipped', lastEventAt: null } });
  });

  it.each(['degraded', 'down'] as const)('a fresh job %s stays visible and is a critical failure when cron is selected', async status => {
    getLatestTelemetry.mockImplementation(async key => receipt(key === 'cron_pending-work' ? status : 'up'));
    const health = await cronHandler.runCheck();
    expect(health.status).toBe(status);
    expect(health.checks).toMatchObject({ verification: 'passive', observedJobs: 12, unknownJobs: 0, observedFailure: true });
    expect(isCriticalFailure(health, ['cron'])).toBe(true);
    expect(health.checks.jobs).toMatchObject({ 'pending-work': { status, verification: 'passive' }, marketplace: { status: 'up' } });
  });

  it('fresh down wins even when every other job has no evidence', async () => {
    getLatestTelemetry.mockImplementation(async key => key === 'cron_workflows' ? receipt('down') : null);
    const health = await cronHandler.runCheck();
    expect(health.status).toBe('down');
    expect(health.checks.verification).toBe('partial');
  });

  it('all fresh receipts passively verify invocation coverage only', async () => {
    getLatestTelemetry.mockImplementation(async () => receipt());
    const health = await cronHandler.runCheck();
    expect(health.status).toBe('up');
    expect(health.checks.verification).toBe('passive');
    expect(health.summary).toContain('downstream completion unverified');
    expect(health.degradedReasons).toEqual([]);
    expect(isCriticalFailure(health, ['cron'])).toBe(false);
  });

  it.each(['false', undefined])('disabled catalog is explicitly exempt (%s), not healthy execution evidence', async enabled => {
    if (enabled === undefined) delete process.env.CATALOG_INDEXING_ENABLED;
    else process.env.CATALOG_INDEXING_ENABLED = enabled;
    getLatestTelemetry.mockImplementation(async () => receipt());
    const health = await cronHandler.runCheck();
    expect(health.status).toBe('up');
    expect(health.checks).toMatchObject({ expectedJobs: 11, observedJobs: 11, unknownJobs: 0, verification: 'passive' });
    expect(health.checks.jobs).toMatchObject({ 'catalog-index': { status: 'skipped', disabled: true, expected: false, reason: 'disabled' } });
    expect(getLatestTelemetry).not.toHaveBeenCalledWith('cron_catalog-index', expect.anything());
  });

  it.each(['skipped', 'invalid', 'future'] as const)('does not treat %s receipts as fresh execution evidence', async kind => {
    getLatestTelemetry.mockImplementation(async () => ({ ...receipt(kind === 'skipped' ? 'skipped' : 'up'),
      ...(kind === 'invalid' ? { created_at: 'invalid' } : kind === 'future' ? { created_at: new Date(Date.now() + 60_000).toISOString() } : {}),
    }));
    expect((await cronHandler.runCheck()).status).toBe('skipped');
  });
});