import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

interface MigrationResults {
  retryClaim: {
    state: 'claimed' | 'busy' | 'completed';
    claim_expires_at?: string;
  };
  storedExpiry: string | null;
  strandedRetryClaim: {
    state: 'claimed' | 'busy' | 'completed';
    claim_expires_at?: string;
  };
  concurrentStates: string[];
  paymentCount: number;
}

describe('provider webhook migrations in PostgreSQL', () => {
  let results: MigrationResults;

  beforeAll(() => {
    const output = execFileSync(
      process.execPath,
      [resolve(
        process.cwd(),
        'src/lib/services/__tests__/provider-webhook-migration-runner.mjs',
      )],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    results = JSON.parse(output) as MigrationResults;
  });

  it('reclaims a failed event with a non-null lease expiry', () => {
    expect(results.retryClaim).toEqual({
      state: 'claimed',
      claim_expires_at: expect.any(String),
    });
    expect(results.storedExpiry).not.toBeNull();
  });

  it('recovers processing rows stranded with a null lease expiry', () => {
    expect(results.strandedRetryClaim).toEqual({
      state: 'claimed',
      claim_expires_at: expect.any(String),
    });
  });

  it('admits only one concurrent claimant for an event', () => {
    expect(results.concurrentStates).toEqual(['busy', 'claimed']);
  });

  it('supports ON CONFLICT inference for payment transaction IDs', () => {
    expect(results.paymentCount).toBe(1);
  });
});
