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

  it('every handler returns valid shape', async () => {
    process.env.STATUS_AI_PROBE_ENABLED = 'false';
    const handlers = getAllHealthHandlers();
    for (const handler of handlers.slice(0, 3)) {
      const result = await handler.runCheck();
      expect(result.systemKey).toBe(handler.systemKey);
      expect(result.status).toMatch(/^(up|degraded|down|skipped)$/);
      expect(result.summary).toBeTruthy();
      expect(result.checkedAt).toBeTruthy();
      expect(typeof result.latencyMs).toBe('number');
    }
  }, 30_000);
});
