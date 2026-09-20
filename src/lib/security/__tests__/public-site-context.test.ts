import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const from = jest.fn();
const getCachedJson = jest.fn();
const setCachedJson = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));
jest.mock('../upstash-rest', () => ({
  getCachedJson,
  setCachedJson,
  sha256: jest.fn(async (value: string) => `hash:${value}`),
}));

import { resolvePublicSiteContext } from '../public-site-context';

describe('resolvePublicSiteContext', () => {
  beforeEach(() => {
    from.mockReset();
    getCachedJson.mockReset();
    setCachedJson.mockReset();
    (getCachedJson as any).mockResolvedValue(null);
    (setCachedJson as any).mockResolvedValue(undefined);
  });

  it('rejects malformed site IDs without querying the database', async () => {
    const site = await resolvePublicSiteContext(
      new Request('https://api.example/api/public/posts?site_id=not-a-uuid'),
    );

    expect(site).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('uses exact URL candidates instead of wildcard searches', async () => {
    const maybeSingle = (jest.fn() as any).mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        url: 'https://example.com',
        name: 'Example',
        description: null,
      },
      error: null,
    });
    const limit = jest.fn(() => ({ maybeSingle }));
    const inFilter = jest.fn(() => ({ limit }));
    const select = jest.fn(() => ({ in: inFilter }));
    (from as any).mockReturnValue({ select });

    const site = await resolvePublicSiteContext(
      new Request('https://api.example/api/public/posts?domain=example.com'),
    );

    expect(site?.name).toBe('Example');
    expect(from).toHaveBeenCalledWith('sites');
    expect(inFilter).toHaveBeenCalledWith(
      'url',
      expect.arrayContaining(['example.com', 'https://example.com']),
    );
    expect(setCachedJson).toHaveBeenCalled();
  });
});
