import { renderToStaticMarkup } from 'react-dom/server';
const mockSummary = jest.fn();
const mockTimelines = jest.fn();
jest.mock('@/lib/status/get-public-summary', () => ({ getPublicSummary: mockSummary }));
jest.mock('@/lib/status/cached-timelines', () => ({ getCachedSystemTimelines: mockTimelines }));
jest.mock('@/lib/status/get-system-timelines', () => ({
  ...jest.requireActual('@/lib/status/get-system-timelines'),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/status/handler-registry', () => ({ getHandlerSystemKeys: () => [] }));
jest.mock('@/app/status/status.module.css', () => ({}));
import StatusPage from '@/app/status/page';
describe('status page evidence display', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T19:00:00Z'));
    mockSummary.mockReset().mockResolvedValue({ overall: 'degraded', overallSla24h: 100,
      lastRunAt: new Date().toISOString(), lastTrigger: 'cron_hourly', stale: false, sourceUnavailable: false,
      observation: { total: 1, observed: 0, unverified: 1, coveragePercent: 0 },
      systems: [{ systemKey: 'ai_text', label: 'AI Text', status: 'skipped', summary: 'Generation unverified',
        checkedAt: new Date().toISOString(), latencyMs: 12, sla: { uptime30d: 99 },
        checks: { providers: { openrouter: { configured: true, liveProbe: false } } } }], slaBySystem: {} });
    mockTimelines.mockReset().mockResolvedValue([{ systemKey: 'ai_text', label: 'AI Text', uptimePercent: 80,
      days: [{ date: '2026-10-20', status: 'degraded', checkCount: 10, observedCheckCount: 10, upCheckCount: 8 }] }]);
  });
  afterEach(() => jest.useRealTimers());
  it('labels observed metrics correctly and never substitutes 30-day data for 90-day data', async () => {
    const html = renderToStaticMarkup(await StatusPage());
    expect(html).toContain('Observed check success (24h)');
    expect(html).toContain('Observation coverage');
    expect(html).toContain('80%');
    expect(html).not.toContain('99%');
    expect(html).not.toContain('90-day uptime');
    expect(html).not.toContain('Overall SLA');
    expect(html).toContain('Unverified');
    expect(html).toContain('openrouter');
    expect(html).not.toContain('✗');
    expect(html).toContain('Evidence and probe scope');
  });
  it('distinguishes loading failure from empty history and reports monitor staleness', async () => {
    mockTimelines.mockRejectedValue(new Error('Synthetic history error'));
    const summary = await mockSummary();
    mockSummary.mockResolvedValue({ ...summary, stale: true, sourceUnavailable: true });
    const html = renderToStaticMarkup(await StatusPage());
    expect(html).toContain('Check history is temporarily unavailable');
    expect(html).toContain('Monitoring evidence is stale');
    expect(html).toContain('Status refresh failed');
    expect(html).not.toContain('Synthetic history error');
  });
});