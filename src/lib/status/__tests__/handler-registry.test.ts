import { randomBytes } from 'node:crypto';
const mockRead = jest.fn().mockResolvedValue({ data: [], error: null });
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({
  from: jest.fn(() => ({ select: jest.fn(() => ({ limit: mockRead })) })),
})) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn(() => ({
  from: jest.fn(() => ({ select: jest.fn(() => ({ limit: mockRead })) })),
  rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
})) }));
jest.mock('@/lib/status/telemetry', () => ({ getLatestTelemetry: jest.fn().mockResolvedValue(null), recordTelemetry: jest.fn().mockResolvedValue(undefined),
  REDIS_TELEMETRY_KEYS: { tracking: 'redis_tracking_queue', recordings: 'redis_recording_queue' },
}));
import { getAllHealthHandlers, getHandlerSystemKeys } from '@/lib/status/handler-registry';

describe('handler-registry', () => {
  it('has unique system keys', () => {
    const keys = getHandlerSystemKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes all AI handlers', () => {
    const keys = getHandlerSystemKeys();
    expect(keys).toContain('ai_portkey');
    expect(keys).toContain('ai_text');
    expect(keys).toContain('ai_image');
  });

  it('includes passive Redis queue health', () => {
    expect(getHandlerSystemKeys()).toContain('redis');
  });

  it('every handler returns valid shape', async () => {
    const originalEnv = process.env;
    process.env = { NODE_ENV: 'test', STATUS_AI_PROBE_ENABLED: 'false',
      NEXT_PUBLIC_SUPABASE_URL: 'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY: randomBytes(32).toString('hex') };
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in offline tests'));
    try {
      for (const handler of getAllHealthHandlers()) {
        const result = await handler.runCheck();
        expect(result.systemKey).toBe(handler.systemKey);
        expect(result.status).toMatch(/^(up|degraded|down|skipped)$/);
        expect(result.summary).toBeTruthy();
        expect(result.checkedAt).toBeTruthy();
        expect(typeof result.latencyMs).toBe('number');
      }
    } finally {
      process.env = originalEnv;
      fetch.mockRestore();
    }
  }, 30_000);
});
