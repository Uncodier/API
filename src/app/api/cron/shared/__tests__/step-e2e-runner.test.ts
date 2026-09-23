import { runE2eScenarios } from '../step-e2e-runner';

jest.mock('@/lib/puppeteer/launch-gate-browser', () => ({
  launchPuppeteerForGate: jest.fn(),
}));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: {
    WORK_DIR: '/vercel/sandbox',
    VISUAL_PROBE_PORT: 3000,
  },
}));

describe('E2E runner infrastructure handling', () => {
  it('fails closed when the sandbox domain is unavailable', async () => {
    const result = await runE2eScenarios({
      sandbox: {
        domain: jest.fn(() => {
          throw new Error('sandbox unavailable');
        }),
      } as any,
      stepOrder: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        infrastructureFailure: true,
        error: expect.stringContaining('sandbox unavailable'),
      }),
    );
  });

  it('treats malformed scenario files as failures', async () => {
    const page = {
      setDefaultNavigationTimeout: jest.fn(),
      setDefaultTimeout: jest.fn(),
      content: jest.fn().mockResolvedValue('<main />'),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const result = await runE2eScenarios({
      sandbox: {
        domain: jest.fn(() => 'https://sandbox.example'),
        runCommand: jest.fn().mockResolvedValue({
          exitCode: 0,
          stdout: jest.fn().mockResolvedValue('.qa/scenarios/broken.json\n'),
        }),
        fs: {
          readFile: jest.fn().mockResolvedValue('{invalid'),
        },
      } as any,
      browser: {
        newPage: jest.fn().mockResolvedValue(page),
      } as any,
      stepOrder: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.scenarios[0]).toEqual(
      expect.objectContaining({
        scenario: '.qa/scenarios/broken.json',
        pass: false,
      }),
    );
  });

  it('records a real form submission response as structured evidence', async () => {
    const response = {
      url: () => 'https://sandbox.example/api/contact',
      status: () => 201,
      request: () => ({ method: () => 'POST' }),
    };
    let submitCallback: (() => void | Promise<void>) | undefined;
    let responsePredicate:
      ((value: typeof response) => boolean) | undefined;
    let resolveResponse: ((value: typeof response) => void) | undefined;
    const page: any = {
      setDefaultNavigationTimeout: jest.fn(),
      setDefaultTimeout: jest.fn(),
      waitForSelector: jest.fn().mockResolvedValue({}),
      exposeFunction: jest.fn(
        async (_name: string, callback: () => void | Promise<void>) => {
          submitCallback = callback;
        },
      ),
      removeExposedFunction: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(undefined),
      waitForResponse: jest.fn((
        predicate: (value: typeof response) => boolean,
      ) => new Promise<typeof response>((resolve) => {
        responsePredicate = predicate;
        resolveResponse = resolve;
      })),
      close: jest.fn().mockResolvedValue(undefined),
      content: jest.fn().mockResolvedValue('<main />'),
    };
    page.click = jest.fn(async () => {
      await submitCallback?.();
      if (responsePredicate?.(response)) resolveResponse?.(response);
    });
    const scenario = JSON.stringify({
      name: 'contact form transaction',
      steps: [{
        action: 'submit',
        selector: 'button[type="submit"]',
        response: {
          path: '/api/contact',
          method: 'POST',
          expected_statuses: [201],
        },
      }],
    });

    const result = await runE2eScenarios({
      sandbox: {
        domain: jest.fn(() => 'https://sandbox.example'),
        runCommand: jest.fn().mockResolvedValue({
          exitCode: 0,
          stdout: jest.fn().mockResolvedValue('.qa/scenarios/contact.json\n'),
        }),
        fs: { readFile: jest.fn().mockResolvedValue(scenario) },
      } as any,
      browser: { newPage: jest.fn().mockResolvedValue(page) } as any,
      stepOrder: 1,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(result.scenarios[0].steps[0].receipt).toEqual({
      kind: 'http_response',
      pass: true,
      method: 'POST',
      target: '/api/contact',
      actual_status: 201,
      expected_statuses: [201],
    });
  });
});
