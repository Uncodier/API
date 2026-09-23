import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runRuntimeAndVisualProbes } from '../step-gate-probes';
import {
  runRuntimeProbe,
  stopProbeServer,
} from '../step-runtime-probe';
import { inferTargetRoutesFromDiff } from '../step-runtime-targets';
import { runVisualProbe } from '../step-visual-probe';
import { runVisualCritic } from '../step-visual-critic';
import { runE2eScenarios } from '../step-e2e-runner';
import { launchPuppeteerForGate } from '@/lib/puppeteer/launch-gate-browser';

type LooseMock = ReturnType<typeof jest.fn<(...args: any[]) => any>>;
const asMock = (value: unknown): LooseMock => value as LooseMock;

jest.mock('../step-runtime-probe', () => ({
  runRuntimeProbe: jest.fn(),
  stopProbeServer: jest.fn(),
  summarizeRuntimeProbe: jest.fn(() => 'ok'),
}));
jest.mock('../step-runtime-targets', () => ({
  inferTargetRoutesFromDiff: jest.fn(),
}));
jest.mock('../step-visual-probe', () => ({
  runVisualProbe: jest.fn(),
}));
jest.mock('../step-visual-critic', () => ({
  runVisualCritic: jest.fn(),
  mergeCriticIntoVisualSignal: jest.fn(),
  verdictBlocksGate: jest.fn(),
}));
jest.mock('../step-e2e-runner', () => ({
  runE2eScenarios: jest.fn(),
}));
jest.mock('@/lib/puppeteer/launch-gate-browser', () => ({
  launchPuppeteerForGate: jest.fn(),
}));
jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: new Proxy({}, { get: (_target, property) => String(property) }),
  logCronInfrastructureEvent:
    jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

describe('runtime and visual probe gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asMock(inferTargetRoutesFromDiff).mockResolvedValue({
      pageRoutes: ['/'],
      apiRoutes: [],
      changedFiles: ['src/app/page.tsx'],
      recentPageRoutes: ['/'],
      recentChangedFiles: ['src/app/page.tsx'],
    });
    asMock(runRuntimeProbe).mockResolvedValue({
      ok: true,
      port: 3000,
      duration_ms: 10,
      server_log_tail: '',
      server_errors: [],
      pages: [
        {
          path: '/',
          http_status: 200,
          content_type: 'text/html',
          body_snippet: '<main>Home</main>',
        },
      ],
      apis: [],
      server_log_path: '/tmp/server.log',
    });
    asMock(stopProbeServer).mockResolvedValue(undefined);
  });

  it('keeps an automatic visual capture outage non-blocking', async () => {
    asMock(runVisualProbe).mockResolvedValue({
      ok: false,
      capture_ok: false,
      duration_ms: 10,
      screenshots: [],
      console: {
        ok: true,
        entries: [],
        page_errors: [],
        failed_requests: [],
      },
      visual_raw: {
        ok: false,
        pass: false,
        error: '0/2 screenshots captured',
        defects: [],
        screenshots: [],
      },
      base_url: 'http://localhost:3000',
      error: '0/2 screenshots captured',
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
    });

    expect(result.ok).toBe(true);
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.signals.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'visual',
        disposition: 'unknown',
      }),
    ]));
    expect(runVisualCritic).not.toHaveBeenCalled();
    expect(stopProbeServer).toHaveBeenCalled();
  });

  it('fails closed when the runtime probe throws', async () => {
    asMock(runRuntimeProbe).mockRejectedValueOnce(
      new Error('sandbox transport failed'),
    );

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        infrastructureFailure: true,
        error: expect.stringContaining('sandbox transport failed'),
      }),
    );
  });

  it('does not fail the gate for an undeclared 404 beside a passing target', async () => {
    asMock(inferTargetRoutesFromDiff).mockResolvedValueOnce({
      pageRoutes: ['/dashboard/assets'],
      apiRoutes: [],
      changedFiles: ['src/app/dashboard/assets/page.tsx'],
      recentPageRoutes: ['/dashboard/assets'],
      recentChangedFiles: ['src/app/dashboard/assets/page.tsx'],
    });
    asMock(runRuntimeProbe).mockResolvedValueOnce({
      ok: true,
      port: 3000,
      duration_ms: 10,
      server_log_tail: '',
      server_errors: [],
      pages: [
        { path: '/', http_status: 404 },
        { path: '/ui', http_status: 404 },
        { path: '/dashboard/assets', http_status: 200 },
      ],
      apis: [],
      server_log_path: '/tmp/server.log',
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
      shouldRunVisual: false,
    });

    expect(result.ok).toBe(true);
    expect(result.signals.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: '/ui',
        disposition: 'advisory',
      }),
    ]));
  });

  it('executes an explicitly declared bodyless mutation target', async () => {
    asMock(runRuntimeProbe).mockResolvedValueOnce({
      ok: true,
      port: 3000,
      duration_ms: 10,
      server_log_tail: '',
      server_errors: [],
      pages: [{ path: '/', http_status: 200 }],
      apis: [{ path: '/api/assets', method: 'POST', http_status: 204 }],
      server_log_path: '/tmp/server.log',
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
      shouldRunVisual: false,
      stepContext: {
        validation_targets: [{
          kind: 'api',
          path: '/api/assets',
          method: 'POST',
          expected_statuses: [204],
        }],
      },
    });

    expect(result.ok).toBe(true);
    expect(runRuntimeProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        apiRoutes: [{
          path: '/api/assets',
          method: 'POST',
          payload: undefined,
          payload_source: 'scenario',
        }],
      }),
    );
  });

  it('runs declared-only contracts without diff inference or visual probes', async () => {
    asMock(runRuntimeProbe).mockResolvedValueOnce({
      ok: true,
      port: 3000,
      duration_ms: 10,
      server_log_tail: '',
      server_errors: [],
      pages: [],
      apis: [{ path: '/api/assets', method: 'POST', http_status: 204 }],
      server_log_path: '/tmp/server.log',
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
      declaredOnly: true,
      stepContext: {
        validation_targets: [{
          kind: 'api',
          path: '/api/assets',
          method: 'POST',
          expected_statuses: [204],
        }],
      },
    });

    expect(result.ok).toBe(true);
    expect(inferTargetRoutesFromDiff).not.toHaveBeenCalled();
    expect(runVisualProbe).not.toHaveBeenCalled();
    expect(runRuntimeProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        apiRoutes: [expect.objectContaining({
          path: '/api/assets',
          method: 'POST',
        })],
      }),
    );
  });

  it('blocks on console failure without converting visual evidence into a defect', async () => {
    asMock(runVisualProbe).mockResolvedValue({
      ok: false,
      capture_ok: true,
      duration_ms: 10,
      screenshots: [{ route: '/', viewport: 'desktop', url: 'shot.jpg' }],
      console: {
        ok: false,
        entries: [{ level: 'error', text: 'Request failed' }],
        page_errors: [],
        failed_requests: [],
      },
      visual_raw: {
        ok: true,
        pass: true,
        defects: [],
        screenshots: [{ route: '/', viewport: 'desktop', url: 'shot.jpg' }],
      },
      base_url: 'http://localhost:3000',
      auth_redirects: [],
      error:
        'Client runtime errors detected. Inspect console entries, page errors, and failed requests, then fix the application-owned errors.',
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
      shouldRunVisual: true,
    });

    expect(result.ok).toBe(false);
    expect(result.signals.console?.ok).toBe(false);
    expect(result.signals.visual).toEqual(expect.objectContaining({
      ok: true,
      pass: true,
    }));
    expect(runVisualCritic).not.toHaveBeenCalled();
  });

  it('fails closed when the E2E runner throws', async () => {
    asMock(launchPuppeteerForGate).mockResolvedValue({
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    asMock(runVisualProbe).mockResolvedValue({
      ok: true,
      capture_ok: true,
      duration_ms: 10,
      screenshots: [],
      console: {
        ok: true,
        entries: [],
        page_errors: [],
        failed_requests: [],
      },
      visual_raw: {
        ok: true,
        pass: true,
        defects: [],
        screenshots: [],
      },
      base_url: 'http://localhost:3000',
      auth_redirects: [],
    });
    asMock(runE2eScenarios).mockRejectedValue(
      new Error('browser transport failed'),
    );

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
      shouldRunVisual: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        infrastructureFailure: true,
        error: expect.stringContaining('browser transport failed'),
      }),
    );
  });

  it('keeps an unavailable automatic visual critic advisory', async () => {
    asMock(runVisualProbe).mockResolvedValue({
      ok: true,
      capture_ok: true,
      duration_ms: 10,
      screenshots: [{
        route: '/',
        viewport: 'desktop',
        url: 'visual-storage://shot.jpg',
      }],
      console: {
        ok: true,
        entries: [],
        page_errors: [],
        failed_requests: [],
      },
      visual_raw: {
        ok: true,
        pass: true,
        defects: [],
        screenshots: [{
          route: '/',
          viewport: 'desktop',
          url: 'visual-storage://shot.jpg',
        }],
      },
      base_url: 'http://localhost:3000',
      auth_redirects: [],
    });
    asMock(runVisualCritic).mockResolvedValue({
      status: 'unavailable',
      pass: false,
      defects: [],
      summary: 'Structured response could not be parsed.',
      skipped: 'parse_error',
      completion_attempts: 2,
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
    });

    expect(result.ok).toBe(true);
    expect(result.signals.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'visual',
        disposition: 'unknown',
      }),
    ]));
  });

  it('keeps automatic browser runtime findings advisory', async () => {
    asMock(runVisualProbe).mockResolvedValue({
      ok: false,
      capture_ok: true,
      duration_ms: 10,
      screenshots: [{
        route: '/',
        viewport: 'desktop',
        url: 'visual-storage://shot.jpg',
      }],
      console: {
        ok: false,
        entries: [],
        page_errors: [],
        failed_requests: [{
          url: 'http://localhost:3000/api/assets',
          route: '/',
          failure: 'net::ERR_FAILED',
          viewport: 'desktop',
          resource_type: 'fetch',
        }],
      },
      visual_raw: {
        ok: true,
        pass: true,
        defects: [],
        screenshots: [{
          route: '/',
          viewport: 'desktop',
          url: 'visual-storage://shot.jpg',
        }],
      },
      base_url: 'http://localhost:3000',
      auth_redirects: [],
      error:
        'Client runtime errors detected. Inspect console entries, page errors, and failed requests, then fix the application-owned errors.',
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 1,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
    });

    expect(result.ok).toBe(true);
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.signals.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'console',
        disposition: 'advisory',
      }),
    ]));
    expect(runVisualCritic).not.toHaveBeenCalled();
  });

  it('uses cumulative page routes for an explicitly forced visual audit', async () => {
    asMock(inferTargetRoutesFromDiff).mockResolvedValueOnce({
      pageRoutes: ['/workspace'],
      apiRoutes: [],
      changedFiles: ['src/app/workspace/page.tsx'],
      recentPageRoutes: [],
      recentChangedFiles: [],
    });
    asMock(launchPuppeteerForGate).mockResolvedValue({
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    asMock(runVisualProbe).mockResolvedValue({
      ok: true,
      capture_ok: true,
      duration_ms: 10,
      screenshots: [],
      console: {
        ok: true,
        entries: [],
        page_errors: [],
        failed_requests: [],
      },
      visual_raw: {
        ok: true,
        pass: true,
        defects: [],
        screenshots: [],
      },
      base_url: 'http://localhost:3000',
      auth_redirects: [],
    });
    asMock(runE2eScenarios).mockResolvedValue({
      ok: true,
      scenarios: [],
      scenarios_read: 0,
      base_url: 'http://localhost:3000',
    });

    const result = await runRuntimeAndVisualProbes({
      sandbox: {} as any,
      stepOrder: 0,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
      shouldRunVisual: true,
      stepContext: {
        protected_routes: ['/workspace'],
      },
    });

    expect(result.ok).toBe(true);
    expect(runVisualProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        pageRoutes: ['/workspace'],
        protectedRoutes: ['/workspace'],
      }),
    );
  });
});
