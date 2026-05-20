import { sanitizePublicPayload } from '@/lib/status/types';

describe('sanitizePublicPayload', () => {
  it('redacts api key patterns in strings', () => {
    const out = sanitizePublicPayload({ msg: 'Failed with sk-abc123secret' });
    expect((out as { msg: string }).msg).not.toContain('sk-abc123');
  });

  it('masks secret-like object keys', () => {
    const out = sanitizePublicPayload({
      apiKey: 'super-secret',
      name: 'azure',
    }) as Record<string, string>;
    expect(out.apiKey).toBe('[set]');
    expect(out.name).toBe('azure');
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(300);
    const out = sanitizePublicPayload(long) as string;
    expect(out.length).toBeLessThanOrEqual(201);
  });
});
