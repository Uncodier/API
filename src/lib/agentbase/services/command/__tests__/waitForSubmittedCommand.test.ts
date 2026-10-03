import { randomUUID } from 'node:crypto';
import { waitForSubmittedCommand } from '../waitForSubmittedCommand';

describe('waitForSubmittedCommand', () => {
  const id = randomUUID();
  const getCommandById = jest.fn();
  const service = { getCommandById };

  beforeEach(() => {
    jest.useFakeTimers();
    getCommandById.mockReset();
  });

  afterEach(() => jest.useRealTimers());

  it('reads the exact submitted identity fresh every two seconds until completion', async () => {
    getCommandById.mockResolvedValueOnce({ id, status: 'running' })
      .mockResolvedValueOnce({ id, status: 'completed', results: [{ ok: true }] });
    const promise = waitForSubmittedCommand(service, id);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(getCommandById).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await promise).toEqual({ commandId: id, command: { id, status: 'completed', results: [{ ok: true }] } });
    expect(getCommandById.mock.calls).toEqual([[id, { fresh: true }], [id, { fresh: true }]]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['failed', 'cancelled'])('stops immediately at terminal state %s', async (status) => {
    getCommandById.mockResolvedValue({ id, status });
    expect(await waitForSubmittedCommand(service, id)).toEqual({ commandId: id, command: { id, status } });
    expect(getCommandById).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves legacy resolution while exposing the canonical database UUID', async () => {
    const legacyId = 'cmd_1790992220939_ox8hy6z';
    getCommandById.mockResolvedValue({ id: legacyId, status: 'completed', metadata: { dbUuid: id } });
    expect((await waitForSubmittedCommand(service, legacyId)).commandId).toBe(id);
    expect(getCommandById).toHaveBeenCalledWith(legacyId, { fresh: true });
  });

  it('keeps memory-only commands local without inventing a database identity', async () => {
    const legacyId = 'cmd_memory_only';
    getCommandById.mockResolvedValue({ id: legacyId, status: 'completed' });
    expect((await waitForSubmittedCommand(service, legacyId)).commandId).toBe(legacyId);
  });

  it('does not retry missing commands', async () => {
    getCommandById.mockResolvedValue(null);
    await expect(waitForSubmittedCommand(service, id)).rejects.toThrow('not found');
    expect(getCommandById).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not swallow a query failure as a still-processing command', async () => {
    const error = Object.assign(new Error('Invalid input'), { code: '22P02' });
    getCommandById.mockRejectedValue(error);
    await expect(waitForSubmittedCommand(service, id)).rejects.toBe(error);
    expect(getCommandById).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds pending polling by elapsed time, not 580 retries', async () => {
    getCommandById.mockResolvedValue({ id, status: 'running' });
    const promise = waitForSubmittedCommand(service, id, { timeoutMs: 5_000 });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await promise).toEqual({ commandId: id, command: null });
    expect(getCommandById).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not start another read while the previous read is pending', async () => {
    let resolveRead!: (command: any) => void;
    getCommandById.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const promise = waitForSubmittedCommand(service, id, { timeoutMs: 5_000 });
    await jest.advanceTimersByTimeAsync(6_000);
    expect(getCommandById).toHaveBeenCalledTimes(1);
    resolveRead({ id, status: 'running' });
    expect(await promise).toEqual({ commandId: id, command: null });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsafe polling interval %s', async (intervalMs) => {
    await expect(waitForSubmittedCommand(service, id, { intervalMs })).rejects.toThrow('positive finite');
    expect(getCommandById).not.toHaveBeenCalled();
  });
});