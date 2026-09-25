import { describe, expect, it } from '@jest/globals';

import { TextHashService } from '../text-hash-service';

describe('TextHashService', () => {
  it('returns the canonical unsigned FNV-1a decimal string', () => {
    expect(TextHashService.hash64String('hello')).toBe('11831194018420276491');
  });

  it('keeps hashes inside the PostgreSQL numeric(20, 0) uint64 constraint', () => {
    const hash = BigInt(TextHashService.hash64String('Makinari'));

    expect(hash).toBeGreaterThanOrEqual(BigInt(0));
    expect(hash).toBeLessThanOrEqual(BigInt('18446744073709551615'));
  });

  it('returns zero for empty input consistently', () => {
    expect(TextHashService.hash64String('')).toBe('0');
  });
});