import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { OutstandClient } from '../client';

describe('Outstand Bluesky connection', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('sends the provider camelCase password field and binds the account to the tenant', async () => {
    const password = randomBytes(12).toString('hex');
    const key = randomBytes(16).toString('hex');
    const handle = 'studio.bsky.social';
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      success: true, data: { id: 'connected-account', network: 'bluesky', username: handle },
    }));
    const client = new OutstandClient(key, AbortSignal.timeout(1000));
    await client.connectBlueskyAccount({ handle, app_password: password }, tenantId);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.outstand.so/v1/social-accounts/bluesky');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'X-Tenant-ID': tenantId } });
    expect(JSON.parse(String(options?.body))).toEqual({ handle, appPassword: password, tenantId });
  });
});