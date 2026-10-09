import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('forward one-credit-per-addon allowance (offline PostgreSQL)', () => {
  it('preserves old paid-window excess through updates and grants one per add-on in new monthly and annual periods', () => {
    const child = spawnSync(process.execPath, [resolve(
      process.cwd(), 'src/lib/services/billing/__tests__/addon-allowance-forward-runner.mjs',
    )], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('PASS forward add-on allowance');
  }, 65_000);
});