import { assertAppsPublicKey } from '@/lib/database/apps-public-key';

const token = (role: string) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.test-signature`;

describe('generated app public key boundary', () => {
  it.each(['sb_publishable_example123', token('anon')])('accepts public-only configuration', key => {
    expect(() => assertAppsPublicKey(key)).not.toThrow();
  });
  it.each(['', 'sb_secret_sensitive', token('service_role'), token('authenticated'), 'malformed.key.parts'])('refuses privileged/malformed credentials without leaking them', key => {
    let error: unknown;
    try { assertAppsPublicKey(key); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('cannot be injected');
    if (key) expect((error as Error).message).not.toContain(key);
  });
});