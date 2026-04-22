import { jest } from '@jest/globals';
import type { VercelWebhookEvent } from '../webhook-types';
import type { ResolvedVercelContext } from '../webhook-resolver';
import type { handleVercelWebhookEvent as HandleFn } from '../process-webhook';

// The project runs with `ts-jest` in native-ESM mode (`useESM: true`), which
// disables the usual `jest.mock` hoisting above `import` statements. The
// ESM-safe pattern is `jest.unstable_mockModule` + dynamic `await import`.
// We also import `jest` from `@jest/globals` because the repo's `jest.setup.js`
// stubs `globalThis.jest` with a noop object too early.

const mockLogCronInfrastructureEvent = jest.fn();
const mockPatchLatestRequirementStatusColumns = jest.fn();
const dedupeBuilder = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  contains: jest.fn().mockReturnThis(),
  limit: jest.fn() as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>,
};

// We can't `await import` the real module inside the factory (it would
// infinitely recurse into the mock). Instead we mirror the exports actually
// consumed by process-webhook: `CronInfraEvent` (just a constant map) and
// `logCronInfrastructureEvent`.
jest.unstable_mockModule('@/lib/services/cron-audit-log', () => ({
  logCronInfrastructureEvent: mockLogCronInfrastructureEvent,
  CronInfraEvent: {
    VERCEL_WEBHOOK_DEPLOYMENT_CREATED: 'cron_infra_vercel_webhook_deployment_created',
    VERCEL_WEBHOOK_DEPLOYMENT_BUILDING: 'cron_infra_vercel_webhook_deployment_building',
    VERCEL_WEBHOOK_DEPLOYMENT_READY: 'cron_infra_vercel_webhook_deployment_ready',
    VERCEL_WEBHOOK_DEPLOYMENT_ERROR: 'cron_infra_vercel_webhook_deployment_error',
    VERCEL_WEBHOOK_DEPLOYMENT_CANCELED: 'cron_infra_vercel_webhook_deployment_canceled',
    VERCEL_WEBHOOK_DEPLOYMENT_PROMOTED: 'cron_infra_vercel_webhook_deployment_promoted',
    PREVIEW_URL_RECORDED: 'cron_infra_preview_url_recorded',
  },
}));

jest.unstable_mockModule('@/app/api/cron/shared/commit/status-sync', () => ({
  patchLatestRequirementStatusColumns: mockPatchLatestRequirementStatusColumns,
}));

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => dedupeBuilder),
  },
}));

let handleVercelWebhookEvent: typeof HandleFn;

beforeAll(async () => {
  ({ handleVercelWebhookEvent } = await import('../process-webhook'));
});

const REQ_ID = '21c35450-1234-4abc-9def-0123456789ab';
const SITE_ID = 'site-uuid-1111';
const INSTANCE_ID = 'instance-uuid-2222';

function buildEvent(overrides: Partial<VercelWebhookEvent> = {}): VercelWebhookEvent {
  return {
    id: 'evt_test_1',
    type: 'deployment.ready',
    createdAt: 1_700_000_000_000,
    payload: {
      projectId: 'prj_apps',
      project: { id: 'prj_apps', name: 'apps' },
      deployment: {
        id: 'dpl_abc',
        url: 'apps-abc-makinari.vercel.app',
        inspectorUrl: 'https://vercel.com/makinari/apps/inspect/dpl_abc',
        target: 'preview',
        source: 'git',
        meta: {
          githubCommitRef: `feature/req-${REQ_ID}`,
          githubCommitSha: 'sha123',
          githubCommitMessage: 'feat: build',
          githubCommitAuthorLogin: 'alice',
          githubRepo: 'apps',
          githubOrg: 'makinari',
        },
      },
    },
    ...overrides,
  };
}

function ctx(overrides: Partial<ResolvedVercelContext> = {}): ResolvedVercelContext {
  return {
    branch: `feature/req-${REQ_ID}`,
    requirementId: REQ_ID,
    siteId: SITE_ID,
    instanceId: INSTANCE_ID,
    gitRepoKind: 'applications',
    isProductionBranch: false,
    ...overrides,
  };
}

function stubDedupe(found: boolean) {
  dedupeBuilder.limit.mockResolvedValue({
    data: found ? [{ id: 'existing-log' }] : [],
    error: null,
  });
}

describe('handleVercelWebhookEvent', () => {
  beforeEach(() => {
    mockLogCronInfrastructureEvent.mockReset();
    mockPatchLatestRequirementStatusColumns.mockReset();
    dedupeBuilder.limit.mockReset();
    stubDedupe(false);
    mockPatchLatestRequirementStatusColumns.mockResolvedValue({ updated: true });
  });

  test('ignores non-deployment events without any DB writes', async () => {
    const out = await handleVercelWebhookEvent(buildEvent({ type: 'project.created' }), {
      resolveContext: async () => ctx(),
    });
    expect(out).toEqual({
      status: 'ignored',
      event: 'project.created',
      reason: 'non-deployment-event',
    });
    expect(mockLogCronInfrastructureEvent).not.toHaveBeenCalled();
    expect(mockPatchLatestRequirementStatusColumns).not.toHaveBeenCalled();
  });

  test('skips production branches (main/master) silently', async () => {
    const out = await handleVercelWebhookEvent(buildEvent(), {
      resolveContext: async () =>
        ctx({ isProductionBranch: true, requirementId: null, branch: 'main' }),
    });
    expect(out).toEqual({
      status: 'ignored',
      event: 'deployment.ready',
      reason: 'production-branch',
    });
    expect(mockLogCronInfrastructureEvent).not.toHaveBeenCalled();
  });

  test('skips branches that do not encode a requirement', async () => {
    const out = await handleVercelWebhookEvent(buildEvent(), {
      resolveContext: async () => ctx({ requirementId: null, branch: 'feature/unrelated' }),
    });
    expect(out).toEqual({
      status: 'ignored',
      event: 'deployment.ready',
      reason: 'no-requirement-branch',
    });
    expect(mockLogCronInfrastructureEvent).not.toHaveBeenCalled();
  });

  test('skips when there is no site for the requirement yet', async () => {
    const out = await handleVercelWebhookEvent(buildEvent(), {
      resolveContext: async () => ctx({ siteId: null }),
    });
    expect(out).toEqual({
      status: 'ignored',
      event: 'deployment.ready',
      reason: 'no-site-for-requirement',
    });
    expect(mockLogCronInfrastructureEvent).not.toHaveBeenCalled();
  });

  test('on deployment.ready logs infrastructure event and patches preview_url', async () => {
    const out = await handleVercelWebhookEvent(buildEvent(), {
      resolveContext: async () => ctx(),
    });

    expect(out).toEqual({
      status: 'processed',
      event: 'deployment.ready',
      requirementId: REQ_ID,
      updatedPreview: true,
    });

    expect(mockLogCronInfrastructureEvent).toHaveBeenCalledTimes(1);
    const [auditCtx, payload] = mockLogCronInfrastructureEvent.mock.calls[0] as [
      { siteId: string; instanceId?: string; requirementId?: string },
      { event: string; level: string; message: string; details: Record<string, unknown> },
    ];
    expect(auditCtx).toEqual({ siteId: SITE_ID, instanceId: INSTANCE_ID, requirementId: REQ_ID });
    expect(payload.event).toBe('cron_infra_vercel_webhook_deployment_ready');
    expect(payload.level).toBe('info');
    expect(payload.details.raw_event_id).toBe('evt_test_1');
    expect(payload.details.deployment_url).toBe('https://apps-abc-makinari.vercel.app');
    expect(payload.details.commit_sha).toBe('sha123');
    expect(payload.details.git_repo_kind).toBe('applications');

    expect(mockPatchLatestRequirementStatusColumns).toHaveBeenCalledWith({
      requirementId: REQ_ID,
      siteId: SITE_ID,
      instanceId: INSTANCE_ID,
      columns: { preview_url: 'https://apps-abc-makinari.vercel.app' },
    });
  });

  test('on deployment.error logs with level=error and does NOT patch preview_url', async () => {
    const out = await handleVercelWebhookEvent(
      buildEvent({
        id: 'evt_err_1',
        type: 'deployment.error',
        payload: {
          ...buildEvent().payload,
          errorCode: 'BUILD_FAILED',
          errorMessage: 'tsc non-zero exit',
        },
      }),
      { resolveContext: async () => ctx() },
    );

    expect(out).toMatchObject({
      status: 'processed',
      event: 'deployment.error',
      updatedPreview: false,
    });

    const [, payload] = mockLogCronInfrastructureEvent.mock.calls[0] as [
      unknown,
      { level: string; details: Record<string, unknown> },
    ];
    expect(payload.level).toBe('error');
    expect(payload.details.error_code).toBe('BUILD_FAILED');
    expect(payload.details.error_message).toBe('tsc non-zero exit');
    expect(mockPatchLatestRequirementStatusColumns).not.toHaveBeenCalled();
  });

  test('on deployment.canceled logs with level=warn', async () => {
    await handleVercelWebhookEvent(buildEvent({ id: 'evt_cxl', type: 'deployment.canceled' }), {
      resolveContext: async () => ctx(),
    });
    const [, payload] = mockLogCronInfrastructureEvent.mock.calls[0] as [
      unknown,
      { level: string; event: string },
    ];
    expect(payload.level).toBe('warn');
    expect(payload.event).toBe('cron_infra_vercel_webhook_deployment_canceled');
  });

  test('dedupes when the same raw_event_id already exists for the site', async () => {
    stubDedupe(true);
    const out = await handleVercelWebhookEvent(buildEvent(), {
      resolveContext: async () => ctx(),
    });

    expect(out).toEqual({ status: 'deduped', event: 'deployment.ready', requirementId: REQ_ID });
    expect(mockLogCronInfrastructureEvent).not.toHaveBeenCalled();
    expect(mockPatchLatestRequirementStatusColumns).not.toHaveBeenCalled();
  });

  test('does not throw when patchLatestRequirementStatusColumns fails on ready', async () => {
    mockPatchLatestRequirementStatusColumns.mockRejectedValueOnce(new Error('db down'));
    const out = await handleVercelWebhookEvent(buildEvent(), {
      resolveContext: async () => ctx(),
    });
    expect(out).toEqual({
      status: 'processed',
      event: 'deployment.ready',
      requirementId: REQ_ID,
      updatedPreview: false,
    });
    expect(mockLogCronInfrastructureEvent).toHaveBeenCalledTimes(1);
  });

  test('still processes deployment.ready when deployment URL is missing (no preview patch)', async () => {
    const ev = buildEvent();
    if (ev.payload.deployment) ev.payload.deployment.url = null;

    const out = await handleVercelWebhookEvent(ev, { resolveContext: async () => ctx() });
    expect(out).toEqual({
      status: 'processed',
      event: 'deployment.ready',
      requirementId: REQ_ID,
      updatedPreview: false,
    });
    expect(mockPatchLatestRequirementStatusColumns).not.toHaveBeenCalled();
  });
});
