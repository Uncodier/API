import { isStatusStale, normalizeHealthStatus, overallHealth, STATUS_STALE_AFTER_MS, summarizeObservations } from '../observation';
import { isCriticalFailure } from '../types';

describe('health evidence semantics', () => {
  it('keeps observed failures and does not turn configuration into failure or success', () => {
    expect(normalizeHealthStatus('down', { verification: 'configuration' })).toBe('down');
    expect(normalizeHealthStatus('degraded', { verification: 'configuration' })).toBe('skipped');
    expect(normalizeHealthStatus('up', { telemetryFound: false })).toBe('skipped');
    expect(normalizeHealthStatus('up', { routesRegistered: true, sideEffectSafe: true })).toBe('skipped');
    expect(normalizeHealthStatus('degraded', { inheritedProviders: { text: { configured: true, liveProbe: false, verification: 'configuration' } } })).toBe('skipped');
    expect(normalizeHealthStatus('degraded', { providers: { text: { configured: true, liveProbe: false, verification: 'inference' } } })).toBe('degraded');
    expect(normalizeHealthStatus('up', { verification: 'contract' })).toBe('up');
    expect(normalizeHealthStatus('up', { sampleRoutes: [{ status: 0 }] })).toBe('down');
    expect(normalizeHealthStatus('up', { routes: [{ status: 404, ok: true }] })).toBe('down');
    expect(normalizeHealthStatus('degraded', { verification: 'partial', observedFailure: false })).toBe('skipped');
    expect(normalizeHealthStatus('degraded', { verification: 'partial', observedFailure: true })).toBe('degraded');
  });
  it('separates coverage from successes and keeps incomplete monitoring degraded', () => {
    const systems = [{ status: 'up', checks: {} }, { status: 'skipped', checks: {} }];
    expect(summarizeObservations(systems)).toEqual({ total: 2, observed: 1, unverified: 1, coveragePercent: 50 });
    expect(overallHealth(systems)).toBe('degraded');
    expect(overallHealth([])).toBe('degraded');
    expect(overallHealth([{ status: 'down', checks: {} }])).toBe('down');
  });
  it('expires evidence with a cadence grace period and fails invalid timestamps closed', () => {
    const now = Date.parse('2026-10-20T19:00:00Z');
    expect(isStatusStale(new Date(now - STATUS_STALE_AFTER_MS).toISOString(), now)).toBe(false);
    expect(isStatusStale(new Date(now - STATUS_STALE_AFTER_MS - 1).toISOString(), now)).toBe(true);
    expect(isStatusStale(null, now)).toBe(true);
    expect(isStatusStale('invalid', now)).toBe(true);
    expect(isStatusStale(new Date(now + 120_000).toISOString(), now)).toBe(true);
  });
  it('does not pass strict required capability gates with unverified checks', () => {
    const capability = { systemKey: 'ai_text', label: 'Text', status: 'skipped' as const, checkedAt: new Date().toISOString(), latencyMs: 0, summary: 'Unverified', checks: {} };
    expect(isCriticalFailure(capability)).toBe(true);
    expect(isCriticalFailure({ ...capability, status: 'up' })).toBe(false);
  });
});