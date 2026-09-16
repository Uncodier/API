import { sandboxIdentity } from '../sandbox-sdk';

jest.mock('@vercel/sandbox', () => ({
  Sandbox: { get: jest.fn() },
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
});
