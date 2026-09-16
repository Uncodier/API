import { runRuntimeAndVisualProbes } from '../step-gate-probes';
import {
  runRuntimeProbe,
  stopProbeServer,
} from '../step-runtime-probe';
import { inferTargetRoutesFromDiff } from '../step-runtime-targets';
import { runVisualProbe } from '../step-visual-probe';
import { runVisualCritic } from '../step-visual-critic';

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
  logCronInfrastructureEvent: jest.fn().mockResolvedValue(undefined),
}));

describe('runtime and visual probe gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (inferTargetRoutesFromDiff as jest.Mock).mockResolvedValue({
      pageRoutes: ['/'],
      apiRoutes: [],
      changedFiles: ['src/app/page.tsx'],
      recentPageRoutes: ['/'],
      recentChangedFiles: ['src/app/page.tsx'],
    });
    (runRuntimeProbe as jest.Mock).mockResolvedValue({
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
    (stopProbeServer as jest.Mock).mockResolvedValue(undefined);
  });

  it('returns a retryable infrastructure failure when planned capture is empty', async () => {
    (runVisualProbe as jest.Mock).mockResolvedValue({
      ok: false,
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

    expect(result.ok).toBe(false);
    expect(result.infrastructureFailure).toBe(true);
    expect(result.error).toContain('Visual probe infrastructure unavailable');
    expect(runVisualCritic).not.toHaveBeenCalled();
    expect(stopProbeServer).toHaveBeenCalled();
  });

  it('fails closed when the runtime probe throws', async () => {
    (runRuntimeProbe as jest.Mock).mockRejectedValueOnce(
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
});
