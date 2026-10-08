import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('annual paid coverage and monthly credits (offline PostgreSQL)', () => {
  it('enforces periods, paid changes, protected balances and authorization', () => {
    const child = spawnSync(process.execPath, [resolve(
      __dirname, 'annual-credit-postgres-runner.mjs',
    )], { encoding: 'utf8', timeout: 90000 });
    expect(child.error).toBeUndefined();
    if (child.status !== 0) throw new Error(`${child.stdout}\n${child.stderr}`);
    expect(child.stdout).toContain('annual credit checks passed');
  }, 100000);
});