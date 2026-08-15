/**
 * status-tests (npm run test:status): unit helpers only — no live HTTP.
 * system-probes (npm run status:probe): live checks + persist + broadcast.
 */
import { GET, POST } from '@/app/api/status/webhook/route';
import { getPublicSummary } from '@/lib/status/get-public-summary';
import { publishSystemStatus } from '@/lib/status/publish-status';
import type { PublicStatusSummary } from '@/lib/status/get-public-summary';

jest.mock('@/lib/status/get-public-summary', () => ({
  getPublicSummary: jest.fn(),
}));

jest.mock('@/lib/status/publish-status', () => ({
  publishSystemStatus: jest.fn(),
}));

const summary: PublicStatusSummary = {
  overall: 'degraded',
  overallSla24h: 99.1,
  lastRunAt: '2026-08-14T00:00:00.000Z',
  lastTrigger: 'cron_hourly',
  systems: [],
  slaBySystem: {},
};

describe('GET/POST /api/status/webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getPublicSummary as jest.Mock).mockResolvedValue(summary);
    (publishSystemStatus as jest.Mock).mockResolvedValue(true);
  });

  it('GET returns the last sanitized snapshot without publishing', async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.overall).toBe('degraded');
    expect(publishSystemStatus).not.toHaveBeenCalled();
  });

  it('POST re-emits the snapshot on the public channel', async () => {
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.published).toBe(true);
    expect(publishSystemStatus).toHaveBeenCalledWith(summary);
  });

  it('GET returns 500 when summary load fails', async () => {
    (getPublicSummary as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
