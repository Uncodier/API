import { describe, expect, it, beforeEach } from '@jest/globals';
import { GET } from '../route';

describe('legacy requirements automations cron', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
  });

  it('rejects unauthenticated callers', async () => {
    const response = await GET(new Request('http://localhost/api/cron/requirements-automations'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('remains unauthorized when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request('http://localhost/api/cron/requirements-automations', {
      headers: { authorization: 'Bearer undefined' },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('is retired and points authenticated callers to the canonical scheduler', async () => {
    const response = await GET(new Request('http://localhost/api/cron/requirements-automations', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      message: 'Legacy requirements-automations scheduler is retired',
      delegatedTo: '/api/cron/requirements-apps',
    });
  });
});
