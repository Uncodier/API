import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('annual credits and checkout leases (disposable socket-only PostgreSQL)', () => {
  it('fences renewal, spending, invoices, first claims and stale paid updates', () => {
    const child = spawnSync(process.execPath, [resolve(__dirname, 'annual-credit-concurrency-runner.mjs')],
      { encoding: 'utf8', timeout: 110_000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('Validated 8 real PostgreSQL annual concurrency scenarios');
  }, 120_000);
});