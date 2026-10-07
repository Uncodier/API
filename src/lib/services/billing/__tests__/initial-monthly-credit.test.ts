import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('initial monthly credit without signup bonus (offline PostgreSQL)', () => {
  it('grants one current-month credit and preserves balances, retries and access controls', () => {
    const child = spawnSync(process.execPath, [resolve(process.cwd(),
      'src/lib/services/billing/__tests__/initial-monthly-credit-runner.mjs')],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 90_000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('Validated 8 initial monthly credit scenarios');
  }, 100_000);
});