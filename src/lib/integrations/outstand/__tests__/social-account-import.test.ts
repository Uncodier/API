import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { OutstandClient } from '../client';

describe('OutstandClient social account import', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists existing import jobs read-only with the tenant header', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [], count: 0 })),
    );
    await new OutstandClient('secret').listSocialAccountImports('yTdoj', 'site-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.outstand.so/v1/social-accounts/yTdoj/imports',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer secret', 'X-Tenant-ID': 'site-1' }),
      }),
    );
  });

  it('uses the provider social-accounts route and tenant header', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, importId: 'import-1' })),
    );
    await new OutstandClient('secret').importSocialAccountPosts('yTdoj', 'site-1', { limit: 10 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.outstand.so/v1/social-accounts/yTdoj/imports',
      expect.objectContaining({
        method: 'POST', body: '{"limit":10}',
        headers: expect.objectContaining({ Authorization: 'Bearer secret', 'X-Tenant-ID': 'site-1' }),
      }),
    );
  });
});
