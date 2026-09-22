import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockMaybeSingle = jest.fn<() => Promise<{
  data: { id: string; used: number; quota_override: number } | null;
}>>();
const mockRpc: any = jest.fn();

const query = {
  select: jest.fn(() => query),
  eq: jest.fn(() => query),
  maybeSingle: mockMaybeSingle,
};

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => query),
    rpc: mockRpc,
  },
}));

import { reserveQuota } from '../platform-quota';

describe('platform quota reservations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'quota-1', used: 3, quota_override: 10 },
    });
  });

  it('reserves quota through one atomic database call', async () => {
    mockRpc.mockResolvedValue({
      data: [{ allowed: true, used: 5, quota_limit: 10 }],
      error: null,
    });

    await expect(reserveQuota({
      site_id: '00000000-0000-4000-8000-000000000001',
      capability: 'email.send',
      cost: 2,
    })).resolves.toEqual({
      allowed: true,
      used: 5,
      limit: 10,
      softWarn: false,
    });

    expect(mockRpc).toHaveBeenCalledWith('reserve_platform_quota', {
      p_site_id: '00000000-0000-4000-8000-000000000001',
      p_capability: 'email.send',
      p_period: expect.any(String),
      p_cost: 2,
      p_default_limit: 200,
    });
  });

  it('returns an exhausted decision without incrementing usage', async () => {
    mockRpc.mockResolvedValue({
      data: [{ allowed: false, used: 9, quota_limit: 10 }],
      error: null,
    });

    const result = await reserveQuota({
      site_id: '00000000-0000-4000-8000-000000000001',
      capability: 'email.send',
      cost: 2,
    });

    expect(result.allowed).toBe(false);
    expect(result.used).toBe(9);
    expect(mockRpc).toHaveBeenCalled();
  });

  it('fails closed when the authoritative reservation is unavailable', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(reserveQuota({
      site_id: '00000000-0000-4000-8000-000000000001',
      capability: 'email.send',
    })).resolves.toMatchObject({
      allowed: false,
      reason: 'Quota service is temporarily unavailable.',
    });
  });
});
