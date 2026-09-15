import { describe, expect, it } from '@jest/globals';
import { sanitizeRuntimeLog } from '../runtime-log-context';

describe('sanitizeRuntimeLog', () => {
  it('keeps pertinent error context and redacts credentials and personal data', () => {
    const result = sanitizeRuntimeLog([
      'ordinary startup noise',
      'request POST /api/orders',
      'Authorization: Bearer secret-token-value',
      'TypeError: Cannot read properties of undefined for person@example.com',
      '    at createOrder (/app/src/orders.ts:42:9)',
      'x-api-key=private-key',
      'Error payload: {"access_token":"json-secret"}',
      'ordinary trailing noise',
    ].join('\n'));

    expect(result).toContain('request POST /api/orders');
    expect(result).toContain('TypeError: Cannot read properties of undefined');
    expect(result).toContain('/app/src/orders.ts:42:9');
    expect(result).toContain('Authorization: [REDACTED]');
    expect(result).toContain('x-api-key=[REDACTED]');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('secret-token-value');
    expect(result).not.toContain('private-key');
    expect(result).not.toContain('json-secret');
    expect(result).not.toContain('person@example.com');
  });

  it('bounds the excerpt size', () => {
    const result = sanitizeRuntimeLog(
      Array.from({ length: 100 }, (_, index) => `Error: failure ${index} ${'x'.repeat(100)}`).join('\n'),
    );

    expect(result.length).toBeLessThanOrEqual(4_100);
    expect(result).toContain('[truncated');
    expect(result).toContain('failure 99');
  });
});
