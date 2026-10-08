import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('Stripe period settlement migration (offline PostgreSQL)', () => {
  it.each([false,true])('preserves verified monthly settlement before/after annual migrations: %s', annual => {
    const child = spawnSync(process.execPath, [resolve(
      process.cwd(), 'src/lib/services/billing/__tests__/stripe-credit-postgres-runner.mjs',
    ), ...(annual ? ['--annual'] : [])], { cwd: process.cwd(), encoding: 'utf8', timeout: 90_000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('Validated 16 PostgreSQL Stripe settlement scenarios');
  }, 100_000);
});