import { randomUUID } from 'node:crypto';
import { getCommandById } from '../command-db';
import { supabaseAdmin } from '../supabase-client';
import { circuitBreakers } from '@/lib/utils/circuit-breaker';

jest.mock('../supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/utils/circuit-breaker', () => ({
  circuitBreakers: { database: { execute: jest.fn((operation) => operation()) } },
}));

describe('command-db UUID boundary and retries', () => {
  const id = randomUUID();
  const single = jest.fn();
  const eq = jest.fn();
  const select = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    single.mockReset();
    (supabaseAdmin.from as jest.Mock).mockReturnValue({ select });
    select.mockReturnValue({ eq });
    eq.mockReturnValue({ single });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['cmd_1790992220939_ox8hy6z', 'invalid', ''])('does not query or count invalid ID %s against the circuit breaker', async (value) => {
    expect(await getCommandById(value)).toBeNull();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(circuitBreakers.database.execute).not.toHaveBeenCalled();
  });

  it('queries a valid UUID normally', async () => {
    single.mockResolvedValue({ data: { id, status: 'completed' }, error: null });
    expect(await getCommandById(id)).toMatchObject({ id, status: 'completed' });
    expect(eq).toHaveBeenCalledWith('id', id);
  });

  it('preserves 22P02 and never retries it', async () => {
    single.mockResolvedValue({ data: null, error: { code: '22P02', message: 'Invalid input' } });
    await expect(getCommandById(id)).rejects.toMatchObject({ code: '22P02' });
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('returns null on a missing row without retrying', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'No row' } });
    expect(await getCommandById(id)).toBeNull();
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('still retries transient database failures with backoff', async () => {
    jest.useFakeTimers();
    single.mockResolvedValueOnce({ data: null, error: { code: '08006', message: 'Connection failed' } })
      .mockResolvedValueOnce({ data: { id }, error: null });
    const promise = getCommandById(id);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await promise).toMatchObject({ id });
    expect(single).toHaveBeenCalledTimes(2);
  });
});