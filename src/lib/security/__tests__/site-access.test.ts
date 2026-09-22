import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canAccessSite } from '@/lib/security/site-access';
import {
  getCachedJson,
  setCachedJson,
} from '@/lib/security/upstash-rest';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('@/lib/security/upstash-rest', () => ({
  getCachedJson: jest.fn(),
  setCachedJson: jest.fn(),
  sha256: jest.fn(),
}));

jest.mock('@/lib/security/request-rate-limit', () => ({
  isInternalServiceRequest: jest.fn(() => false),
}));

function requestForUser(userId: string): Request {
  return {
    headers: new Headers({ 'x-auth-user-id': userId }),
  } as Request;
}

function queryReturning(data: unknown) {
  const query: any = {};
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.maybeSingle = jest.fn().mockResolvedValue({ data, error: null });
  return query;
}

describe('canAccessSite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCachedJson as jest.Mock).mockResolvedValue(null);
    (setCachedJson as jest.Mock).mockResolvedValue(undefined);
  });

  it('allows an active site member when direct ownership is absent', async () => {
    const directSite = queryReturning(null);
    const ownership = queryReturning(null);
    const membership = queryReturning({ site_id: 'site-1' });
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(directSite)
      .mockReturnValueOnce(ownership)
      .mockReturnValueOnce(membership);

    await expect(canAccessSite(requestForUser('user-1'), 'site-1'))
      .resolves.toBe(true);
    expect(membership.eq).toHaveBeenCalledWith('status', 'active');
    expect(setCachedJson).toHaveBeenCalledWith(
      'auth:site:user-1:site-1',
      { allowed: true },
      60,
    );
  });

  it('rejects users without ownership or an active membership', async () => {
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(queryReturning(null))
      .mockReturnValueOnce(queryReturning(null))
      .mockReturnValueOnce(queryReturning(null));

    await expect(canAccessSite(requestForUser('user-2'), 'site-1'))
      .resolves.toBe(false);
    expect(setCachedJson).toHaveBeenCalledWith(
      'auth:site:user-2:site-1',
      { allowed: false },
      10,
    );
  });
});
