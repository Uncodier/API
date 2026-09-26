import {
  buildVisualProbePlan,
  extractPageRoutesFromStepContext,
  extractVisualFeedbackScreenshotUrl,
  formatVisualGateFeedback,
  resolveProtectedVisualRoutes,
  selectVisualFeedbackScreenshotUrl,
} from '../step-visual-feedback';
import { deriveCategoriesFailed, formatIterationSignals } from '../step-iteration-signals';
import { buildStepRetryFeedback } from '../single-turn-visual-feedback';
import { extractSingleTurnBackgroundState } from '../single-turn-background-task';
import { generateVisualProbeScript } from '../step-visual-probe-script';
import {
  resolveVisualCriticModel,
  runVisualCritic,
  verdictBlocksGate,
} from '../step-visual-critic';
import { fetchVisualScreenshotDataUrl } from '../visual-screenshot-data';
import { requestVisualCriticCompletion } from '../visual-critic-client';

jest.mock('../visual-screenshot-data', () => ({
  fetchVisualScreenshotDataUrl: jest.fn(),
}));
jest.mock('../visual-critic-client', () => ({
  requestVisualCriticCompletion: jest.fn(),
}));

const mockedFetchVisualScreenshotDataUrl =
  fetchVisualScreenshotDataUrl as jest.MockedFunction<
    typeof fetchVisualScreenshotDataUrl
  >;

describe('protected visual routes', () => {
  it('marks high-confidence authenticated route prefixes only', () => {
    expect(resolveProtectedVisualRoutes([
      '/',
      '/dashboard/work-orders',
      '/protected',
      '/admin/users',
      '/login',
      '/pricing',
      '/workspace/orders',
    ], [
      '/workspace/orders',
    ])).toEqual([
      '/dashboard/work-orders',
      '/protected',
      '/admin/users',
      '/workspace/orders',
    ]);
  });
});
const mockedRequestVisualCriticCompletion =
  requestVisualCriticCompletion as jest.MockedFunction<
    typeof requestVisualCriticCompletion
  >;

beforeEach(() => {
  jest.clearAllMocks();
  mockedFetchVisualScreenshotDataUrl.mockResolvedValue(
    'data:image/jpeg;base64,dmlzdWFs',
  );
});

describe('visual critic evidence completeness', () => {
  it('does not request a verdict from a partially loaded batch', async () => {
    mockedFetchVisualScreenshotDataUrl
      .mockResolvedValueOnce('data:image/jpeg;base64,Zmlyc3Q=')
      .mockResolvedValueOnce(null);

    const result = await runVisualCritic({
      requirementId: 'req-1',
      screenshots: [
        { route: '/one', viewport: 'desktop', url: 'https://signed/one' },
        { route: '/two', viewport: 'desktop', url: 'https://signed/two' },
      ],
      step: { order: 1 },
    });

    expect(result.skipped).toBe('screenshots_incomplete');
    expect(mockedRequestVisualCriticCompletion).not.toHaveBeenCalled();
  });
});

describe('visual feedback planning', () => {
  it('skips automatic visual work for backend-only changes', () => {
    const plan = buildVisualProbePlan({
      gitRepoKind: 'applications',
      changedFiles: ['src/app/api/bookings/route.ts'],
      inferredPageRoutes: [],
    });

    expect(plan.enabled).toBe(false);
    expect(plan.reason).toBe('no_frontend_changes');
  });

  it('captures one affected route at mobile and desktop sizes', () => {
    const plan = buildVisualProbePlan({
      gitRepoKind: 'applications',
      changedFiles: ['src/components/bookings/booking-list.tsx'],
      inferredPageRoutes: [],
      stepContext: {
        instructions: 'Finish the booking flow rendered at /dashboard/bookings.',
      },
    });

    expect(plan.enabled).toBe(true);
    expect(plan.routes).toEqual(['/dashboard/bookings']);
    expect(plan.viewports.map((viewport) => viewport.name)).toEqual(['mobile', 'desktop']);
    expect(plan.routes.length * plan.viewports.length).toBe(2);
    expect(plan.runScenarios).toBe(false);
  });

  it('enables visual checks when dependency inference found an affected page', () => {
    const plan = buildVisualProbePlan({
      gitRepoKind: 'applications',
      changedFiles: ['server/generated-manifest.json'],
      inferredPageRoutes: ['/dashboard'],
    });

    expect(plan.enabled).toBe(true);
    expect(plan.routes).toEqual(['/dashboard']);
  });

  it('prioritizes the step protected route over unrelated affected pages', () => {
    const plan = buildVisualProbePlan({
      gitRepoKind: 'applications',
      changedFiles: ['src/components/auth/auth-button.tsx'],
      inferredPageRoutes: ['/auth/error', '/auth/forgot-password'],
      stepContext: {
        protected_routes: ['/dashboard/assets'],
      },
    });

    expect(plan.routes).toEqual(['/dashboard/assets', '/auth/error']);
  });

  it('caps multiple routes to two desktop screenshots', () => {
    const plan = buildVisualProbePlan({
      explicit: true,
      gitRepoKind: 'applications',
      changedFiles: [],
      inferredPageRoutes: ['/one', '/two', '/three'],
    });

    expect(plan.routes).toEqual(['/one', '/two']);
    expect(plan.viewports.map((viewport) => viewport.name)).toEqual(['desktop']);
    expect(plan.routes.length * plan.viewports.length).toBe(2);
    expect(plan.runScenarios).toBe(true);
  });

  it('ignores API and source-file paths in step context', () => {
    expect(
      extractPageRoutesFromStepContext({
        instructions: 'Connect /api/bookings from /dashboard, edit /src/lib/client.ts and components/ui/button.tsx, then inspect hydration/runtime errors at https://example.com/docs.',
      }),
    ).toEqual(['/dashboard']);
  });

  it('does not probe prose punctuation as part of a route', () => {
    expect(extractPageRoutesFromStepContext({
      instructions: "Open '/dashboard.' then check /contacto!",
    })).toEqual(['/dashboard', '/contacto']);
  });
});

describe('visual feedback formatting', () => {
  const screenshots = [
    { route: '/dashboard', viewport: 'mobile', url: 'https://example.supabase.co/mobile.jpg' },
    { route: '/dashboard', viewport: 'desktop', url: 'https://example.supabase.co/desktop.jpg' },
  ];

  it('puts the most useful screenshot and highest severity defect in retry feedback', () => {
    const feedback = formatVisualGateFeedback(
      {
        summary: 'The mobile layout is unusable.',
        defects: [
          {
            category: 'copy',
            severity: 'minor',
            route: '/dashboard',
            viewport: 'desktop',
            description: 'One label is verbose.',
          },
          {
            category: 'responsive',
            severity: 'blocker',
            route: '/dashboard',
            viewport: 'mobile',
            description: 'The main content overflows.',
            fix_hint: 'Remove the fixed width.',
          },
        ],
      },
      screenshots,
    );

    expect(feedback).toContain('visual_screenshot_url: https://example.supabase.co/mobile.jpg');
    expect(feedback.indexOf('[blocker/responsive]')).toBeLessThan(
      feedback.indexOf('[minor/copy]'),
    );
    expect(extractVisualFeedbackScreenshotUrl(feedback)).toBe(
      'https://example.supabase.co/mobile.jpg',
    );
  });

  it('supports opaque screenshot locators without persisting bearer tokens', () => {
    const opaque =
      'visual-storage://storage/workspaces/probe-screenshots/req-req-1/step-1/mobile.jpg';
    const feedback = formatVisualGateFeedback(
      {
        summary: 'The mobile navigation is broken.',
        defects: [{
          category: 'responsive',
          severity: 'major',
          route: '/dashboard',
          viewport: 'mobile',
          description: 'Navigation overlaps content.',
        }],
      },
      [{ route: '/dashboard', viewport: 'mobile', url: opaque }],
    );

    expect(extractVisualFeedbackScreenshotUrl(feedback)).toBe(opaque);

    const legacyFeedback = formatVisualGateFeedback(
      {
        summary: 'Legacy locator.',
        defects: [{
          category: 'responsive',
          severity: 'major',
          route: '/dashboard',
          viewport: 'mobile',
          description: 'Navigation overlaps content.',
        }],
      },
      [{
        route: '/dashboard',
        viewport: 'mobile',
        url: 'https://example.supabase.co/shot.jpg?token=secret-token',
      }],
    );
    expect(legacyFeedback).not.toContain('secret-token');
  });

  it('classifies a failed critic verdict as a visual failure', () => {
    const categories = deriveCategoriesFailed({
      visual: {
        ok: true,
        pass: false,
        defects: [],
        screenshots: [],
      },
    });

    expect(categories).toContain('visual');
  });

  it('does not duplicate a console-only failure as a visual failure', () => {
    const categories = deriveCategoriesFailed({
      console: {
        ok: false,
        entries: [{ level: 'error', text: 'Request failed' }],
        page_errors: [],
        failed_requests: [],
      },
      visual: {
        ok: true,
        pass: true,
        defects: [],
        screenshots: [],
      },
    });

    expect(categories).toEqual(['console']);
  });

  it('does not select an expensive feedback image for minor-only feedback', () => {
    expect(
      selectVisualFeedbackScreenshotUrl(
        {
          summary: 'Small polish issue.',
          defects: [
            {
              category: 'copy',
              severity: 'minor',
              route: '/dashboard',
              viewport: 'desktop',
              description: 'Label could be shorter.',
            },
          ],
        },
        screenshots,
      ),
    ).toBeUndefined();
  });

  it('keeps retry context compact and uses real newlines', () => {
    const text = formatIterationSignals({
      attempt: 1,
      max_attempts: 2,
      step: { order: 3, title: 'Dashboard' },
      categories_failed: ['visual'],
      visual: {
        ok: false,
        pass: false,
        summary: 'Responsive layout failed.',
        defects: [
          {
            category: 'responsive',
            severity: 'major',
            route: '/dashboard',
            viewport: 'mobile',
            description: 'Content overflows.',
          },
        ],
        screenshots,
      },
    });

    expect(text).toContain('## VISUAL CRITIC\nverdict: FAIL');
    expect(text).toContain('screenshot: /dashboard (mobile)');
    expect(text).not.toContain('\\n');
  });
});

describe('single-turn feedback helpers', () => {
  it('keeps non-visual retry feedback text-only', async () => {
    const feedback = await buildStepRetryFeedback('npm run build failed');

    expect(feedback.promptFragment).toContain('npm run build failed');
    expect(feedback.imageMessage).toBeUndefined();
  });

  it('identifies a visual image so it is injected at most once', async () => {
    const firstError = [
      'Visual critic blocked the gate.',
      'visual_screenshot_url: https://example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-1/mobile.jpg?token=first',
    ].join('\n');
    const secondError = firstError.replace('token=first', 'token=second');
    const first = await buildStepRetryFeedback(firstError, undefined, 'req-1');
    const repeated = await buildStepRetryFeedback(
      secondError,
      first.imageFeedbackId,
      'req-1',
    );

    expect(first.imageFeedbackId).toBeDefined();
    expect(repeated.imageFeedbackId).toBe(first.imageFeedbackId);
    expect(repeated.imageMessage).toBeUndefined();
  });

  it('does not mark visual feedback delivered when the image fetch fails', async () => {
    mockedFetchVisualScreenshotDataUrl.mockResolvedValueOnce(null);
    const feedback = await buildStepRetryFeedback(
      [
        'Visual critic blocked the gate.',
        'visual_screenshot_url: https://example.supabase.co/mobile.jpg',
      ].join('\n'),
    );

    expect(feedback.imageFeedbackId).toBeUndefined();
    expect(feedback.imageMessage).toBeUndefined();
  });

  it('preserves background command state outside the main executor', () => {
    const state = extractSingleTurnBackgroundState({
      messages: [
        {
          role: 'tool',
          name: 'sandbox_start_background_command',
          tool_call_id: 'call-1',
          content: JSON.stringify({
            success: true,
            pid: 123,
            log_file: '/tmp/test.log',
          }),
        },
      ],
    });

    expect(state.backgroundTask).toEqual({
      pid: '123',
      logFile: '/tmp/test.log',
      toolCallId: 'call-1',
    });
  });
});

describe('visual probe script', () => {
  it('generates valid compact JPEG capture JavaScript', () => {
    const script = generateVisualProbeScript({
      port: 3000,
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      pageRoutes: ['/dashboard'],
      pageTimeoutMs: 15_000,
      fullPage: false,
      imageType: 'jpeg',
      imageQuality: 60,
      hydrationWaitMs: 500,
      maxImageBytes: 900_000,
      protectedRoutes: ['/dashboard'],
    });

    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('const FULL_PAGE = false');
    expect(script).toContain('const IMAGE_TYPE = "jpeg"');
    expect(script).toContain('const HYDRATION_WAIT_MS = 500');
    expect(script).not.toContain('test-key');
    expect(script).toContain("const CAPTURE_DIRECTORY = '/tmp/visual-probe-captures'");
    expect(script).toContain("crypto.createHash('sha256').update(route)");
    expect(script).toContain('authRedirects.push');
    expect(script).toContain('new URL(value, LOCAL_ORIGIN)');
    expect(script).toContain('PROTECTED_ROUTES.has(requested.pathname)');
    expect(script).toContain('files.uncodie.com/tracking.min.js');
    expect(script).toContain('script[data-uncodie-harness="tracking"]');
    expect(script).toContain('harnessTrackingScopes');
    expect(script).toContain('authRedirect.expected');
    expect(script).toContain('restoreTelemetry(checkpoint)');
    expect(script).toContain('redirected_to: authRedirect.redirectedTo');
    expect(script).toContain('route: safeRoute');
    expect(script).toContain('final_route: finalRoute');
  });
});

describe('visual critic model selection', () => {
  it('uses a low-cost vision model unless explicitly overridden', () => {
    expect(resolveVisualCriticModel(undefined, { AI_PROVIDER: 'gemini' })).toBe(
      'gemini-2.5-flash',
    );
    expect(
      resolveVisualCriticModel('custom-vision-model', { AI_PROVIDER: 'gemini' }),
    ).toBe('custom-vision-model');
  });

  it('uses deterministic defect thresholds instead of the model pass boolean', () => {
    expect(
      verdictBlocksGate({
        status: 'verified',
        pass: false,
        summary: 'Model was stricter than the gate policy.',
        defects: [
          {
            category: 'spacing',
            severity: 'major',
            route: '/',
            viewport: 'desktop',
            description: 'One spacing issue.',
          },
        ],
      }),
    ).toBe(false);

    expect(
      verdictBlocksGate({
        status: 'verified',
        pass: true,
        summary: 'Model returned an inconsistent pass.',
        defects: [
          {
            category: 'broken_visual',
            severity: 'blocker',
            route: '/',
            viewport: 'desktop',
            description: 'Page is unusable.',
          },
        ],
      }),
    ).toBe(true);
  });
});
