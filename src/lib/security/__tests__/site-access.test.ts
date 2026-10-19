import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canAccessSite } from '@/lib/security/site-access';
import {
  getCachedJson,
  setCachedJson,
} from '@/lib/security/upstash-rest';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
    rpc: jest.fn(),
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

const rpcResult = (data: unknown, error: unknown = null) => ({
  abortSignal: jest.fn().mockResolvedValue({ data, error }),
});

describe('canAccessSite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCachedJson as jest.Mock).mockResolvedValue(null);
    (setCachedJson as jest.Mock).mockResolvedValue(undefined);
  });

  it('allows an active site member when direct ownership is absent', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(true));

    await expect(canAccessSite(requestForUser('user-1'), 'site-1'))
      .resolves.toBe(true);
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith('site_user_has_effective_access', {
      p_site_id: 'site-1', p_user_id: 'user-1',
    });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(setCachedJson).not.toHaveBeenCalled();
  });

  it('rejects users without ownership or an active membership', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(false));

    await expect(canAccessSite(requestForUser('user-2'), 'site-1'))
      .resolves.toBe(false);
    expect(setCachedJson).not.toHaveBeenCalled();
  });

  it('ignores an old positive cache when the trial member has expired', async () => {
    (getCachedJson as jest.Mock).mockResolvedValue({ allowed: true });
    (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(false));
    await expect(canAccessSite(requestForUser('expired'), 'site-1')).resolves.toBe(false);
    expect(getCachedJson).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it.each([null, {}, 'true', 1])('denies an unconfirmed effective access response %j', async data => {
    (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(data));
    await expect(canAccessSite(requestForUser('user'), 'site-1')).resolves.toBe(false);
  });

  it('fails closed for missing RPC or transport failure without reading raw flags', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(true, { code: 'PGRST202' }));
    await expect(canAccessSite(requestForUser('user'), 'site-1')).resolves.toBe(false);
    (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => { throw new Error('Unavailable'); });
    await expect(canAccessSite(requestForUser('user'), 'site-1')).resolves.toBe(false);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('preserves tenant-scoped machine credentials without allowing another tenant', async () => {
    const request = { headers: new Headers({ 'x-api-key-data': JSON.stringify({ site_id: 'site-1' }) }) } as Request;
    await expect(canAccessSite(request, 'site-1')).resolves.toBe(true);
    await expect(canAccessSite(request, 'site-2')).resolves.toBe(false);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  });
});
