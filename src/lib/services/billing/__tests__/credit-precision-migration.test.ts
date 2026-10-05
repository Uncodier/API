import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('exact credit accounting migration (offline PostgreSQL)', () => {
  it('reproduces legacy rounding and conserves fractional balances, usage and ledger after widening', () => {
    const child = spawnSync(process.execPath, [resolve(
      process.cwd(), 'src/lib/services/billing/__tests__/credit-precision-postgres-runner.mjs',
    )], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('Validated 8 PostgreSQL credit precision scenarios');
  }, 100_000);
});