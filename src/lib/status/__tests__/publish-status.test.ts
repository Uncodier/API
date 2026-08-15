/**
 * status-tests (npm run test:status): unit helpers only — no live HTTP.
 * system-probes (npm run status:probe): live checks + persist + broadcast.
 */
import {
  SYSTEM_STATUS_BROADCAST_EVENT,
  SYSTEM_STATUS_CHANNEL,
  buildStatusBroadcastBody,
  publishSystemStatus,
} from '@/lib/status/publish-status';
import type { PublicStatusSummary } from '@/lib/status/get-public-summary';

jest.mock('@/lib/database/supabase-client', () => ({
  getSupabaseServiceRoleUrl: jest.fn(() => 'https://example.supabase.co'),
}));

const sampleSummary = (): PublicStatusSummary => ({
  overall: 'operational',
  overallSla24h: 100,
  lastRunAt: '2026-08-14T00:00:00.000Z',
  lastTrigger: 'manual',
  systems: [
    {
      systemKey: 'env_core',
      label: 'Core Environment',
      status: 'up',
      summary: 'ok',
      latencyMs: 1,
      checkedAt: '2026-08-14T00:00:00.000Z',
      checks: { apiKey: 'super-secret' },
    },
  ],
  slaBySystem: {},
});

describe('publishSystemStatus', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    jest.clearAllMocks();
  });

  it('builds a sanitized broadcast body for the public channel', () => {
    const body = JSON.parse(buildStatusBroadcastBody(sampleSummary()));
    expect(body.messages[0].topic).toBe(SYSTEM_STATUS_CHANNEL);
    expect(body.messages[0].event).toBe(SYSTEM_STATUS_BROADCAST_EVENT);
    expect(body.messages[0].payload.systems[0].checks.apiKey).toBe('[set]');
  });

  it('POSTs the snapshot to the Realtime HTTP broadcast API', async () => {
    const ok = await publishSystemStatus(sampleSummary());
    expect(ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.supabase.co/realtime/v1/api/broadcast',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'test-service-role',
          Authorization: 'Bearer test-service-role',
        }),
      }),
    );
  });

  it('returns false when broadcast HTTP fails without throwing', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    await expect(publishSystemStatus(sampleSummary())).resolves.toBe(false);
  });

  it('returns false when service role key is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(publishSystemStatus(sampleSummary())).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
