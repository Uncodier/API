const mockRpc = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    rpc: mockRpc,
  },
}));

import {
  computeOverallSla,
  computeSlaBySystem,
} from '@/lib/status/compute-sla';

describe('status SLA computation', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('does not represent missing SLA data as 100% availability', () => {
    expect(computeOverallSla({})).toBeNull();
  });

  it('averages the 24-hour SLA across systems', () => {
    expect(computeOverallSla({
      api: { uptime24h: 100, uptime7d: 99, uptime30d: 98 },
      database: { uptime24h: 90, uptime7d: 95, uptime30d: 97 },
    })).toBe(95);
  });

  it('excludes systems without 24-hour checks from the overall SLA', () => {
    expect(computeOverallSla({
      api: { uptime24h: null, uptime7d: 99, uptime30d: 98 },
      database: { uptime24h: 90, uptime7d: 95, uptime30d: 97 },
    })).toBe(90);
  });

  it('throws when the SLA RPC fails', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(computeSlaBySystem()).rejects.toThrow(
      'Failed to compute system status SLA: database unavailable',
    );
  });

  it('returns no SLA values when the RPC has no rows', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await expect(computeSlaBySystem()).resolves.toEqual({});
  });

  it('maps aggregate counts to SLA windows', async () => {
    mockRpc.mockResolvedValue({
      data: [{
        system_key: 'api',
        total_24h: 4,
        up_24h: 3,
        total_7d: 10,
        up_7d: 9,
        total_30d: 20,
        up_30d: 19,
      }],
      error: null,
    });

    await expect(computeSlaBySystem()).resolves.toEqual({
      api: {
        uptime24h: 75,
        uptime7d: 90,
        uptime30d: 95,
      },
    });
  });

  it('returns null for SLA windows without checks', async () => {
    mockRpc.mockResolvedValue({
      data: [{
        system_key: 'api',
        total_24h: 0,
        up_24h: 0,
        total_7d: 0,
        up_7d: 0,
        total_30d: 1,
        up_30d: 1,
      }],
      error: null,
    });

    await expect(computeSlaBySystem()).resolves.toEqual({
      api: {
        uptime24h: null,
        uptime7d: null,
        uptime30d: 100,
      },
    });
  });
});
