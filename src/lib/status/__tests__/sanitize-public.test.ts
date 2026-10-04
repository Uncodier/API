import { randomBytes } from 'node:crypto';
import { sanitizePublicPayload } from '@/lib/status/types';

describe('sanitizePublicPayload', () => {
  it('redacts api key patterns in strings', () => {
    const token = randomBytes(32).toString('hex');
    const out = sanitizePublicPayload({ msg: `Failed with sk-or-v1-${token}` });
    expect(out.msg).not.toContain(token);
  });

  it('masks secret-like object keys', () => {
    const apiKey = randomBytes(32).toString('hex');
    const out = sanitizePublicPayload({
      apiKey,
      name: 'azure',
    }) as Record<string, string>;
    expect(out.apiKey).toBe('[set]');
    expect(JSON.stringify(out)).not.toContain(apiKey);
    expect(out.name).toBe('azure');
  });

  it('preserves the historical system key and redacts credentials before truncation', () => {
    const username = randomBytes(12).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/status');
    url.username = username;
    url.password = password;
    url.searchParams.set('api_key', token);
    const result = sanitizePublicPayload({ systemKey: 'ai_portkey', message: `${url} Bearer ${token} ${'x'.repeat(250)}` });
    expect(result.systemKey).toBe('ai_portkey');
    for (const sensitive of [username, password, token]) {
      expect(JSON.stringify(result)).not.toContain(sensitive);
    }
  });

  it('removes unlabelled configured credentials from provider messages', () => {
    const original = process.env.OPENROUTER_API_KEY;
    const key = randomBytes(32).toString('hex');
    process.env.OPENROUTER_API_KEY = key;
    try {
      expect(sanitizePublicPayload(`upstream rejected ${key}`)).not.toContain(key);
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(300);
    const out = sanitizePublicPayload(long) as string;
    expect(out.length).toBeLessThanOrEqual(201);
  });
});
