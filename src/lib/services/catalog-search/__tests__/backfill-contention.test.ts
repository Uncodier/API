import { spawnSync } from 'node:child_process';

it('runs disposable multi-session PostgreSQL backfill contention regressions', () => {
  const child = spawnSync(process.execPath, ['--test', '__tests__/catalog/catalog-backfill-contention.test.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 70000,
  });
  expect({ status: child.status, stderr: child.stderr, error: child.error })
    .toEqual({ status: 0, stderr: '', error: undefined });
}, 75000);
