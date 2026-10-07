import { APIError, Sandbox } from '@vercel/sandbox';
import { isMissingSandboxSnapshotError, retireSandboxWithoutSnapshots } from '../sandbox-missing-snapshot';

jest.mock('@vercel/sandbox', () => {
  class APIError extends Error {
    constructor(public response: Response, options: { json: unknown }) {
      super('Sandbox API error');
      this.json = options.json;
    }
    json: unknown;
  }
  return { APIError, Sandbox: { get: jest.fn() } };
});

describe('missing snapshot recovery', () => {
  const name = 'req-21c35450-abcd1234';
  const assertOwnership = jest.fn();
  let sandbox: any;
  beforeEach(() => {
    jest.resetAllMocks();
    sandbox = {
      name, status: 'stopped', currentSnapshotId: 'snapshot-expired',
      createdAt: new Date('2026-10-01T00:00:00Z'), statusUpdatedAt: new Date('2026-10-01T01:00:00Z'),
      listSnapshots: jest.fn().mockResolvedValue({ snapshots: [], pagination: { next: null } }),
      listSessions: jest.fn().mockResolvedValue({ sessions: [{ status: 'stopped' }], pagination: { next: null } }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    (Sandbox.get as jest.Mock).mockResolvedValue(sandbox);
    assertOwnership.mockResolvedValue(undefined);
  });

  function apiError(status: number, code: string, message: string) {
    return new APIError(new Response(null, { status }), { json: { error: { code, message } } });
  }

  it('recognizes only the exact typed legacy missing-snapshot response', () => {
    expect(isMissingSandboxSnapshotError(apiError(400, 'bad_request', 'Cannot resume sandbox: no snapshot available.'))).toBe(true);
    expect(isMissingSandboxSnapshotError(new Error('Cannot resume sandbox: no snapshot available.'))).toBe(false);
    expect(isMissingSandboxSnapshotError(apiError(403, 'bad_request', 'Cannot resume sandbox: no snapshot available.'))).toBe(false);
    expect(isMissingSandboxSnapshotError(apiError(400, 'not_found', 'Cannot resume sandbox: no snapshot available.'))).toBe(false);
    expect(isMissingSandboxSnapshotError(apiError(400, 'bad_request', 'Different failure'))).toBe(false);
    expect(isMissingSandboxSnapshotError(apiError(410, 'snapshot_not_found', 'Snapshot not found'))).toBe(true);
    expect(isMissingSandboxSnapshotError(apiError(410, 'gone', 'Different failure'))).toBe(false);
  });

  it('retires only the stopped shell after ownership checks and a metadata re-read', async () => {
    await retireSandboxWithoutSnapshots(name, assertOwnership);
    expect(Sandbox.get).toHaveBeenCalledTimes(2);
    expect(Sandbox.get).toHaveBeenCalledWith({ name, resume: false });
    expect(sandbox.listSnapshots).toHaveBeenCalledWith({ limit: 50 });
    expect(sandbox.listSessions).toHaveBeenCalledWith({ limit: 50 });
    expect(assertOwnership).toHaveBeenCalledTimes(2);
    expect(sandbox.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: false });
  });

  it.each(['running', 'pending', 'stopping', 'snapshotting', 'failed'])(
    'preserves a %s sandbox', async status => {
      sandbox.status = status;
      await expect(retireSandboxWithoutSnapshots(name, assertOwnership)).rejects.toThrow('not stopped');
      expect(sandbox.delete).not.toHaveBeenCalled();
    },
  );

  it('preserves every remaining snapshot', async () => {
    sandbox.listSnapshots.mockResolvedValue({ snapshots: [{ status: 'created' }], pagination: { next: null } });
    await expect(retireSandboxWithoutSnapshots(name, assertOwnership)).rejects.toThrow('snapshots or active sessions');
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it.each(['snapshots', 'sessions'])('rejects incomplete %s inventory', async kind => {
    const method = kind === 'snapshots' ? 'listSnapshots' : 'listSessions';
    sandbox[method].mockResolvedValue({ [kind]: [], pagination: { next: 'more' } });
    await expect(retireSandboxWithoutSnapshots(name, assertOwnership)).rejects.toThrow('snapshots or active sessions');
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it('preserves a sandbox with an active session', async () => {
    sandbox.listSessions.mockResolvedValue({ sessions: [{ status: 'running' }], pagination: { next: null } });
    await expect(retireSandboxWithoutSnapshots(name, assertOwnership)).rejects.toThrow('snapshots or active sessions');
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it.each(['name', 'status', 'currentSnapshotId', 'createdAt', 'statusUpdatedAt'])(
    'refuses changed %s during inspection', async key => {
      const change = key.endsWith('At') ? new Date('2026-10-02T00:00:00Z') : 'changed';
      (Sandbox.get as jest.Mock).mockResolvedValueOnce(sandbox).mockResolvedValueOnce({ ...sandbox, [key]: change });
      await expect(retireSandboxWithoutSnapshots(name, assertOwnership)).rejects.toThrow('changed during inspection');
      expect(sandbox.delete).not.toHaveBeenCalled();
    },
  );

  it('refuses stale ownership immediately before deletion', async () => {
    assertOwnership.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('owner changed'));
    await expect(retireSandboxWithoutSnapshots(name, assertOwnership)).rejects.toThrow('owner changed');
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it('does not delete after inspection API failure', async () => {
    sandbox.listSnapshots.mockRejectedValue(new Error('transport unavailable'));
    await expect(retireSandboxWithoutSnapshots(name, assertOwnership)).rejects.toThrow('transport unavailable');
    expect(sandbox.delete).not.toHaveBeenCalled();
  });
});