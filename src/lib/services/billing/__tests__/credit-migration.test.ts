import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('monthly credit migration (offline PostgreSQL)', () => {
  it('enforces signup, periods, purchases, cancellation and financial authorization', () => {
    const child = spawnSync(process.execPath, [resolve(
      process.cwd(), 'src/lib/services/billing/__tests__/credit-postgres-runner.mjs',
    )], { cwd: process.cwd(), encoding: 'utf8', timeout: 90_000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('Validated 13 PostgreSQL credit scenarios');
  }, 100_000);
});