import { runVisualProbe } from '../step-visual-probe';
import {
  cleanupLocalVisualCaptures,
  persistVisualCaptures,
  resolveVisualStorageConfig,
} from '../visual-screenshot-storage';
import { generateVisualProbeScript } from '../step-visual-probe-script';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { VISUAL_PROBE_PORT: 3000 },
}));
jest.mock('../visual-screenshot-storage', () => ({
  cleanupLocalVisualCaptures: jest.fn(),
  persistVisualCaptures: jest.fn(),
  resolveVisualStorageConfig: jest.fn(),
}));
jest.mock('../step-visual-probe-script', () => ({
  generateVisualProbeScript: jest.fn(),
}));

describe('visual probe result semantics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (resolveVisualStorageConfig as jest.Mock).mockReturnValue({
      url: 'https://storage.example',
      serviceKey: 'service-key',
      bucket: 'workspaces',
    });
    (generateVisualProbeScript as jest.Mock).mockReturnValue(
      'console.log("{}")',
    );
    (cleanupLocalVisualCaptures as jest.Mock).mockResolvedValue(undefined);
    (persistVisualCaptures as jest.Mock).mockResolvedValue({
      screenshots: [{
        route: '/',
        viewport: 'desktop',
        url: 'visual-storage://storage/workspaces/shot.jpg',
        storage_path: 'shot.jpg',
      }],
      errors: [],
    });
  });

  it('keeps successful capture separate from console failure', async () => {
    const probeOutput = JSON.stringify({
      screenshots: [{
        route: '/',
        viewport: 'desktop',
        local_path: '/tmp/visual-probe-captures/shot.jpg',
        content_type: 'image/jpeg',
        byte_size: 10,
      }],
      consoleEntries: [{
        level: 'error',
        text: 'Application render failed',
        route: '/',
        viewport: 'desktop',
      }],
      pageErrors: [],
      failedRequests: [],
      authRedirects: [],
    });
    const sandbox = {
      domain: jest.fn(() => 'http://localhost:3000'),
      runCommand: jest.fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: jest.fn().mockResolvedValue(`${probeOutput}\n`),
          stderr: jest.fn().mockResolvedValue(''),
        }),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: {
        rm: jest.fn().mockResolvedValue(undefined),
      },
    };

    const result = await runVisualProbe({
      sandbox: sandbox as any,
      port: 3000,
      pageRoutes: ['/'],
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      requirementId: 'req-1',
      stepOrder: 1,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      capture_ok: true,
      error: expect.stringContaining('Inspect console entries'),
    }));
    expect(result.console.ok).toBe(false);
    expect(result.visual_raw).toEqual(expect.objectContaining({
      ok: true,
      pass: true,
      defects: [],
      error: undefined,
    }));
  });

  it('fails the probe without misclassifying telemetry truncation as capture failure', async () => {
    const probeOutput = JSON.stringify({
      screenshots: [{
        route: '/',
        viewport: 'desktop',
        local_path: '/tmp/visual-probe-captures/shot.jpg',
        content_type: 'image/jpeg',
        byte_size: 10,
      }],
      consoleEntries: [],
      pageErrors: [],
      failedRequests: [],
      telemetryDropped: { console: 1 },
      authRedirects: [],
    });
    const sandbox = {
      domain: jest.fn(() => 'http://localhost:3000'),
      runCommand: jest.fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: jest.fn().mockResolvedValue(`${probeOutput}\n`),
          stderr: jest.fn().mockResolvedValue(''),
        }),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: {
        rm: jest.fn().mockResolvedValue(undefined),
      },
    };

    const result = await runVisualProbe({
      sandbox: sandbox as any,
      port: 3000,
      pageRoutes: ['/'],
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      requirementId: 'req-1',
      stepOrder: 1,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      capture_ok: true,
      error: expect.stringContaining('telemetry was truncated'),
    }));
    expect(result.console.ok).toBe(false);
    expect(result.visual_raw.ok).toBe(true);
  });
});
