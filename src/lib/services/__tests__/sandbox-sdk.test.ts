import { Sandbox } from '@vercel/sandbox';
import { getSandboxHandle, sandboxIdentity } from '../sandbox-sdk';
import { stopSandboxQuiet } from '../sandbox-stop';

jest.mock('@vercel/sandbox', () => ({
  Sandbox: { get: jest.fn(), getOrCreate: jest.fn() },
}));

describe('sandboxIdentity', () => {
  it('uses the SDK v3 name', () => {
    expect(sandboxIdentity({ name: 'sandbox-v3' } as any)).toBe('sandbox-v3');
  });

  it('falls back to the legacy SDK id', () => {
    expect(sandboxIdentity({ sandboxId: 'sandbox-v1' } as any)).toBe(
      'sandbox-v1',
    );
  });

  it('uses the SDK v3 name parameter when reconnecting', async () => {
    const sandbox = { name: 'sandbox-v3' };
    (Sandbox.get as jest.Mock).mockResolvedValue(sandbox);

    await expect(getSandboxHandle('sandbox-v3')).resolves.toBe(sandbox);
    expect(Sandbox.get).toHaveBeenCalledWith({ name: 'sandbox-v3' });
  });

  it('stops SDK v3 sandboxes without legacy options', async () => {
    const stop = jest.fn().mockResolvedValue(undefined);

    await expect(stopSandboxQuiet({ stop } as any)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledWith();
  });
});
