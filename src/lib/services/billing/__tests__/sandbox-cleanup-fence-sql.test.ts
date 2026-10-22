import { spawnSync } from 'node:child_process';
it('enforces durable sandbox cleanup fencing in disposable offline PostgreSQL', () => {
  const result = spawnSync(process.execPath, ['src/lib/services/billing/__tests__/sandbox-cleanup-fence-sql-runner.mjs'], {
    encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect(result.status).toBe(0);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  expect(result.stdout).toContain('PASS SQL cleanup fencing');
});