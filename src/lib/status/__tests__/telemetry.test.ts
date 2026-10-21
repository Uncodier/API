import { randomBytes } from 'node:crypto';
const mockInsert = jest.fn();
const mockAbort = jest.fn();
const mockClaim = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => ({
  insert: (value: unknown) => { mockInsert(value); return { abortSignal: mockAbort }; },
})) } }));
jest.mock('@/lib/security/upstash-rest', () => ({ claimKey: mockClaim, sha256: jest.fn(async () => 'synthetic-fingerprint') }));
import { recordTelemetry } from '../telemetry';
describe('durable telemetry sampling', () => {
  beforeEach(() => { mockClaim.mockReset(); mockInsert.mockReset(); mockAbort.mockReset().mockResolvedValue({ error: null }); });
  it.each(['acquired', 'unavailable', 'unconfigured'])('records real observations when sampling is %s', async state => {
    mockClaim.mockResolvedValue({ state });
    await recordTelemetry('api_auth', 'up', 'Authenticated', 10);
    expect(mockInsert).toHaveBeenCalledWith({ system_key: 'api_auth', status: 'up', message: 'Authenticated', latency_ms: 10 });
    expect(mockAbort).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
  it('suppresses duplicates but never stores skipped as success', async () => {
    mockClaim.mockResolvedValueOnce({ state: 'contended' }).mockResolvedValue({ state: 'acquired' });
    await recordTelemetry('api_auth', 'up');
    await recordTelemetry('cron_tracking', 'skipped');
    expect(mockInsert).not.toHaveBeenCalled();
  });
  it('retains failure evidence', async () => {
    mockClaim.mockResolvedValue({ state: 'unavailable' });
    const message = `Synthetic failure ${randomBytes(8).toString('hex')}`;
    await recordTelemetry('cron_tracking', 'down', message, 12);
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'down', message }));
    expect(mockClaim).not.toHaveBeenCalled();
  });
  it('never suppresses the latest failure during down/up/down transitions', async () => {
    mockClaim.mockResolvedValue({ state: 'contended' });
    await recordTelemetry('ai_text', 'down', 'Provider failed');
    await recordTelemetry('ai_text', 'up', 'Provider succeeded');
    await recordTelemetry('ai_text', 'down', 'Provider failed');
    await recordTelemetry('ai_text', 'degraded', 'Provider uncertain');
    expect(mockInsert.mock.calls.map(([row]) => row.status)).toEqual(['down', 'up', 'down', 'degraded']);
    expect(mockClaim).not.toHaveBeenCalled();
  });
  it('bounds writes and never logs raw provider/database errors', async () => {
    const secret = randomBytes(24).toString('hex');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      mockAbort.mockRejectedValue(new Error(secret));
      await recordTelemetry('ai_text', 'down', 'Provider failed');
      expect(timeout).toHaveBeenCalledWith(3000);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      expect(warn).toHaveBeenCalledWith('[Telemetry] Evidence write unavailable');
    } finally { warn.mockRestore(); timeout.mockRestore(); }
  });
});