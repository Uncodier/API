import { evaluateAiProviders } from '@/lib/status/types';
import type { ProviderProbeResult } from '@/lib/status/types';

describe('evaluateAiProviders', () => {
  const up = (overrides: Partial<ProviderProbeResult> = {}): ProviderProbeResult => ({
    configured: true,
    liveProbe: true,
    latencyMs: 10,
    model: 'test',
    ...overrides,
  });

  const failed = (): ProviderProbeResult => ({
    configured: true,
    liveProbe: false,
    latencyMs: 10,
    model: 'test',
    errorCode: 'AUTH_FAILED',
  });

  it('returns degraded when non-primary provider fails', () => {
    const { status, degradedReasons } = evaluateAiProviders(
      { azure: up(), gemini: failed() },
      ['azure'],
    );
    expect(status).toBe('degraded');
    expect(degradedReasons.some((r) => r.includes('gemini'))).toBe(true);
  });

  it('returns down when all primary providers fail live probe', () => {
    const { status } = evaluateAiProviders({ azure: failed() }, ['azure']);
    expect(status).toBe('down');
  });

  it('returns up when all configured providers pass', () => {
    const { status } = evaluateAiProviders(
      { azure: up(), gemini: up() },
      ['azure'],
    );
    expect(status).toBe('up');
  });

  it('returns down when no providers configured but primary required', () => {
    const { status } = evaluateAiProviders(
      {
        azure: { configured: false, liveProbe: false, latencyMs: 0, model: 'x', skipped: true },
      },
      ['azure'],
    );
    expect(status).toBe('down');
  });

  it('treats configured without liveProbe as down for sole primary', () => {
    const { status } = evaluateAiProviders(
      {
        azure: { configured: true, liveProbe: false, latencyMs: 0, model: 'x', errorCode: 'PROBE_DISABLED' },
      },
      ['azure'],
    );
    expect(status).toBe('down');
  });
});
