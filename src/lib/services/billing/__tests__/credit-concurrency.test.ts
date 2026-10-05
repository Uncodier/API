import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('credit migrations (disposable socket-only real PostgreSQL)', () => {
  it('serializes signup, purchases, renewal, spending and cancellation with atomic rollback', () => {
    const child = spawnSync(process.execPath, [resolve(process.cwd(),
      'src/lib/services/billing/__tests__/credit-concurrency-runner.mjs')],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 110_000 });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('Validated 15 real PostgreSQL concurrency scenarios');
  }, 120_000);
});