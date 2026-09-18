import { sandboxCaptureScreenshotsTool } from '../visual-tools';
import {
  deductSandboxToolCredits,
  liveSandbox,
} from '@/app/api/agents/tools/sandbox/assistantProtocol';
import {
  runRuntimeProbe,
  stopProbeServer,
} from '@/app/api/cron/shared/step-runtime-probe';
import { runVisualProbe } from '@/app/api/cron/shared/step-visual-probe';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { VISUAL_PROBE_PORT: 3000 },
}));
jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol', () => ({
  deductSandboxToolCredits: jest.fn(),
  liveSandbox: jest.fn(),
}));
jest.mock('@/app/api/cron/shared/step-runtime-probe', () => ({
  runRuntimeProbe: jest.fn(),
  stopProbeServer: jest.fn(),
}));
jest.mock('@/app/api/cron/shared/step-visual-probe', () => ({
  runVisualProbe: jest.fn(),
}));
jest.mock('@/app/api/cron/shared/step-visual-critic', () => ({
  runVisualCritic: jest.fn(),
}));

describe('sandbox screenshot visual tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (deductSandboxToolCredits as jest.Mock).mockResolvedValue({
      success: true,
    });
    (liveSandbox as jest.Mock).mockImplementation((sandbox) => sandbox);
    (runRuntimeProbe as jest.Mock).mockResolvedValue({
      ok: true,
      port: 3000,
      startup_error: undefined,
      server_log_tail: '',
      server_errors: [],
    });
    (stopProbeServer as jest.Mock).mockResolvedValue(undefined);
  });

  it('exposes aggregate, capture, and console status independently', async () => {
    (runVisualProbe as jest.Mock).mockResolvedValue({
      ok: false,
      capture_ok: true,
      duration_ms: 25,
      screenshots: [{
        route: '/',
        viewport: 'desktop',
        url: 'visual-storage://shot.jpg',
      }],
      console: {
        ok: false,
        entries: [{ level: 'error', text: 'Application render failed' }],
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
      error:
        'Client runtime errors detected. Inspect console entries, page errors, and failed requests.',
    });
    const sandbox = {};
    const tool = sandboxCaptureScreenshotsTool(
      sandbox as any,
      'req-1',
    );

    const result = await tool.execute({
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      capture_ok: true,
      console_ok: false,
      error: expect.stringContaining('Inspect console entries'),
    }));
    expect(stopProbeServer).toHaveBeenCalledWith(sandbox, 3000);
  });
});
