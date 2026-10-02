import { runGateForFlow } from '../gates';
import { verifyDatabaseGate } from '../gates/gate-database';
import { runAppGate } from '../gates/gate-app';
import { runTaskGate } from '../gates/gate-task';

jest.mock('../gates/gate-database', () => ({ verifyDatabaseGate: jest.fn() }));
jest.mock('../gates/gate-app', () => ({ runAppGate: jest.fn() }));
jest.mock('../gates/gate-task', () => ({ runTaskGate: jest.fn() }));
jest.mock('../gates/gate-doc', () => ({ runDocGate: jest.fn() }));
jest.mock('../gates/gate-contract', () => ({ runContractGate: jest.fn() }));
jest.mock('../gates/gate-slides', () => ({ runSlidesGate: jest.fn() }));
jest.mock('../gates/gate-backend', () => ({ runBackendGate: jest.fn() }));

const input = { flow: 'app' as const, requirementId: 'req', sandbox: { id: 'original' } as any, workDir: '/vercel/sandbox' };

describe('migration gate ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (verifyDatabaseGate as jest.Mock).mockResolvedValue(null);
    (runAppGate as jest.Mock).mockResolvedValue({ ok: true, flow: 'app', signals: [] });
  });

  it('checks receipts before builds, pushes or runtime validation', async () => {
    const failure = { ok: false, flow: 'app', continueImplementation: true, signals: [], error: 'pending' };
    (verifyDatabaseGate as jest.Mock).mockResolvedValue(failure);
    await expect(runGateForFlow(input)).resolves.toBe(failure);
    expect(runAppGate).not.toHaveBeenCalled();
  });

  it('checks again when product validation recovers a different workspace', async () => {
    const replacement = { id: 'replacement' } as any;
    (runAppGate as jest.Mock).mockResolvedValue({ ok: true, flow: 'app', signals: [], sandboxReplacement: replacement });
    (verifyDatabaseGate as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({
      ok: false, flow: 'app', continueImplementation: true, signals: [], error: 'recovered file missing',
    });
    await expect(runGateForFlow(input)).resolves.toMatchObject({ ok: false, sandboxReplacement: replacement });
    expect(verifyDatabaseGate).toHaveBeenNthCalledWith(2, expect.objectContaining({ sandbox: replacement }));
  });

  it('does not replace a failed product gate with migration success', async () => {
    (runAppGate as jest.Mock).mockResolvedValue({ ok: false, flow: 'app', signals: [], error: 'test failed' });
    await expect(runGateForFlow(input)).resolves.toMatchObject({ ok: false, error: 'test failed' });
    expect(verifyDatabaseGate).toHaveBeenCalledTimes(1);
  });

  it('does not require tenant migration infrastructure for artifact tasks', async () => {
    (runTaskGate as jest.Mock).mockResolvedValue({ ok: true, flow: 'task', signals: [] });
    await expect(runGateForFlow({ ...input, flow: 'task' })).resolves.toMatchObject({ ok: true });
    expect(verifyDatabaseGate).not.toHaveBeenCalled();
  });
});