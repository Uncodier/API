/**
 * status-tests (npm run test:status): unit helpers only — no live HTTP.
 * system-probes (npm run status:probe): live checks + persist + broadcast.
 */
import { persistProbeRun } from '@/lib/status/persist-status';
import { publishSystemStatus } from '@/lib/status/publish-status';
import type { SystemHealthResponse } from '@/lib/status/types';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table === 'system_status_runs') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: { id: 'run-1' }, error: null }),
            }),
          }),
        };
      }
      return {
        insert: jest.fn().mockResolvedValue({ error: null }),
      };
    }),
  },
}));

jest.mock('@/lib/status/compute-sla', () => ({
  computeSlaBySystem: jest.fn().mockResolvedValue({
    env_core: { uptime24h: 100, uptime7d: 100, uptime30d: 100 },
  }),
  computeOverallSla: jest.fn().mockReturnValue(100),
}));

jest.mock('@/lib/status/publish-status', () => ({
  publishSystemStatus: jest.fn().mockResolvedValue(true),
}));

const system = (overrides: Partial<SystemHealthResponse> = {}): SystemHealthResponse => ({
  systemKey: 'env_core',
  label: 'Core Environment',
  status: 'up',
  checkedAt: '2026-08-14T00:00:00.000Z',
  latencyMs: 4,
  summary: 'ok',
  checks: { ready: true },
  ...overrides,
});

describe('persistProbeRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists then broadcasts a public snapshot', async () => {
    const result = await persistProbeRun('github_push', [system()], 12);
    expect(result.runId).toBe('run-1');
    expect(result.overallStatus).toBe('healthy');
    expect(publishSystemStatus).toHaveBeenCalledTimes(1);
    const payload = (publishSystemStatus as jest.Mock).mock.calls[0][0];
    expect(payload.overall).toBe('operational');
    expect(payload.lastTrigger).toBe('github_push');
    expect(payload.systems[0].systemKey).toBe('env_core');
  });

  it('still returns the run when broadcast rejects', async () => {
    (publishSystemStatus as jest.Mock).mockRejectedValueOnce(new Error('realtime down'));
    const result = await persistProbeRun('manual', [system({ status: 'degraded' })], 8);
    expect(result.runId).toBe('run-1');
    expect(result.overallStatus).toBe('degraded');
  });
});
