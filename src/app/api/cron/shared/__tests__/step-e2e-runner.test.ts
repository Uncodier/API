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
});
