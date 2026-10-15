import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('conserves actual-cost credits and enforces idempotency/ACLs in offline PostgreSQL', () => {
  const result = spawnSync(process.execPath, [resolve(
    __dirname, 'openrouter-cost-postgres-runner.mjs',
  )], { encoding: 'utf8', timeout: 30000 });
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('PASS 10 OpenRouter actual-cost PostgreSQL checks');
  expect(result.status).toBe(0);
}, 35000);