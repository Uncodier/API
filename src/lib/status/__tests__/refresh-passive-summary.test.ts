const mockText = jest.fn();
const mockRead = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
jest.mock('@/lib/status/handlers/ai/provider-probes', () => ({ probeOpenRouterText: mockText }));
jest.mock('@/lib/status/handlers/ai/audio', () => ({ aiAudioHandler: { runCheck: () => mockRead('ai_audio') } }));
jest.mock('@/lib/status/handlers/ai/image', () => ({ aiImageHandler: { runCheck: () => mockRead('ai_image') } }));
jest.mock('@/lib/status/handlers/ai/video', () => ({ aiVideoHandler: { runCheck: () => mockRead('ai_video') } }));
jest.mock('@/lib/status/handlers/cron', () => ({ cronHandler: { runCheck: () => mockRead('cron') } }));
jest.mock('@/lib/status/handlers/integrations', () => ({ integrationsHandler: { runCheck: () => mockRead('integrations') } }));
jest.mock('@/lib/status/handlers/notifications', () => ({ notificationsHandler: { runCheck: () => mockRead('notifications') } }));
jest.mock('@/lib/status/handlers/auth', () => ({ apiAuthHandler: { runCheck: () => mockRead('api_auth') } }));
jest.mock('@/lib/security/upstash-rest', () => ({ getCachedJson: mockGet, setCachedJson: mockSet }));
import { refreshPassiveSummary } from '../refresh-passive-summary';
import type { PublicStatusSummary } from '../get-public-summary';

const now = '2026-10-20T20:45:00.000Z';
const card = (systemKey: string, status = 'skipped', checks = {}) => ({
  systemKey, status, checks, summary: 'Old hourly snapshot', label: systemKey, latencyMs: 0,
  checkedAt: '2026-10-20T20:00:00.000Z', sla: { uptime24h: 50, uptime7d: 75, uptime30d: 80 },
});
const snapshot = (): PublicStatusSummary => ({ overall: 'degraded', overallSla24h: 50,
  lastRunAt: '2026-10-20T20:00:00.000Z', lastTrigger: 'cron_hourly', stale: false, sourceUnavailable: false,
  slaBySystem: {}, systems: [card('ai_text'), card('ai_portkey'),
    card('ai_text_continuation', 'skipped', { continuationRouteRegistered: true, continuationHttpStatus: 400 }),
    card('notifications'), card('database_main', 'up')] });

describe('passive evidence refresh between hourly runs', () => {
  beforeEach(() => {
    jest.clearAllMocks(); jest.useFakeTimers().setSystemTime(new Date(now));
    mockGet.mockResolvedValue(null); mockSet.mockResolvedValue(true);
    mockText.mockResolvedValue({ configured: true, liveProbe: false, verification: 'passive',
      observedHealthy: true, observedStatus: 'up', observedAt: now, latencyMs: 22, model: 'test/model' });
    mockRead.mockImplementation(async systemKey => ({ systemKey, status: systemKey === 'notifications' ? 'up' : 'skipped',
      summary: 'Latest operation receipt', checkedAt: now, latencyMs: 5,
      checks: { verification: systemKey === 'notifications' ? 'observed' : 'configuration' } }));
  });
  afterEach(() => jest.useRealTimers());
  it('uses receipts immediately while preserving original hourly run and historical percentages', async () => {
    const result = await refreshPassiveSummary(snapshot());
    expect(result.systems.find(s => s.systemKey === 'ai_text')).toMatchObject({ status: 'up', checkedAt: now, latencyMs: 22 });
    expect(result.systems.find(s => s.systemKey === 'ai_text_continuation')).toMatchObject({ status: 'up' });
    expect(result.systems.find(s => s.systemKey === 'notifications')).toMatchObject({ status: 'up', checkedAt: now });
    expect(result.lastRunAt).toBe('2026-10-20T20:00:00.000Z');
    expect(result.overallSla24h).toBe(50);
    expect(result.systems[0].sla?.uptime24h).toBe(50);
    expect(result.overall).toBe('operational');
    expect(mockText).toHaveBeenCalledWith({ passiveOnly: true });
    expect(mockSet).toHaveBeenCalledWith(expect.stringContaining('passive:v1:'), expect.any(Array), 15);
  });
  it('cannot cause a live generation even when the opt-in flag is true', async () => {
    const old = process.env.STATUS_AI_PROBE_ENABLED;
    process.env.STATUS_AI_PROBE_ENABLED = 'true';
    try { await refreshPassiveSummary(snapshot()); expect(mockText).toHaveBeenCalledWith({ passiveOnly: true }); }
    finally { if (old === undefined) delete process.env.STATUS_AI_PROBE_ENABLED; else process.env.STATUS_AI_PROBE_ENABLED = old; }
  });
  it('new failures replace an old healthy snapshot', async () => {
    mockText.mockResolvedValue({ configured: true, liveProbe: false, verification: 'passive',
      observedHealthy: false, observedStatus: 'down', observedAt: now, model: 'test/model', latencyMs: 10 });
    const result = await refreshPassiveSummary(snapshot());
    expect(result.overall).toBe('down');
    expect(result.systems[0].status).toBe('down');
  });
  it('does not assert route health or recent cron coverage based on text receipts', async () => {
    const summary = snapshot(); summary.systems[2] = card('ai_text_continuation', 'down', { continuationRouteRegistered: false, continuationHttpStatus: 404 });
    expect((await refreshPassiveSummary(summary)).systems[2].status).toBe('down');
  });
  it('does not turn a stale monitor green after one fresh execution', async () => {
    expect((await refreshPassiveSummary({ ...snapshot(), stale: true })).overall).toBe('degraded');
  });
  it('coalesces readers and reuses bounded passive cached results', async () => {
    const summary = snapshot();
    await Promise.all([refreshPassiveSummary(summary), refreshPassiveSummary(summary)]);
    expect(mockText).toHaveBeenCalledTimes(1);
    mockGet.mockResolvedValue(mockSet.mock.calls[0][1]);
    await refreshPassiveSummary(summary);
    expect(mockText).toHaveBeenCalledTimes(1);
  });
  it('reports evidence-store failure without changing the last snapshot to healthy', async () => {
    mockText.mockRejectedValue(new Error('Unavailable'));
    expect(await refreshPassiveSummary(snapshot())).toMatchObject({ overall: 'degraded', sourceUnavailable: true });
    expect(mockSet).not.toHaveBeenCalled();
  });
  it('does nothing when there is no persisted system inventory', async () => {
    const empty = { ...snapshot(), systems: [] };
    expect(await refreshPassiveSummary(empty)).toBe(empty);
    expect(mockText).not.toHaveBeenCalled();
  });
});