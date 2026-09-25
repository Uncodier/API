/**
 * TextHashService
 * Provides a fast, stable 64-bit hash over input text.
 * We use a simple FNV-1a 64-bit implementation that returns a bigint.
 * For storage we can stringify it; for comparison we can compare stringified values.
 */

export class TextHashService {
  /**
   * Compute a 64-bit FNV-1a hash for a string. Returns bigint.
   */
  static hash64(input: string): bigint {
    if (!input || typeof input !== 'string') return BigInt(0);
    let hash = BigInt('0xcbf29ce484222325'); // FNV offset basis
    const FNV_PRIME = BigInt('0x100000001b3');
    for (let i = 0; i < input.length; i++) {
      hash ^= BigInt(input.charCodeAt(i));
      hash = (hash * FNV_PRIME) & BigInt('0xFFFFFFFFFFFFFFFF'); // 64-bit wrap
    }
    return hash < BigInt(0) ? -hash : hash;
  }

  /**
   * Return the canonical unsigned decimal representation used by Postgres.
   * PostgreSQL numeric(20, 0) can store the complete uint64 range without
   * losing precision, unlike JavaScript numbers or PostgreSQL bigint.
   */
  static hash64String(input: string): string {
    return this.hash64(input).toString();
  }
}


