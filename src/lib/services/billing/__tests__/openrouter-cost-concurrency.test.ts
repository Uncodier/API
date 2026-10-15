import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('charges concurrent generations and sandbox observations exactly once with real PostgreSQL locks', () => {
  const result = spawnSync(process.execPath, [resolve(__dirname, 'openrouter-cost-concurrency-runner.mjs')],
    { encoding: 'utf8', timeout: 45000 });
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('PASS real PostgreSQL concurrent generation');
  expect(result.stdout).toContain('PASS real PostgreSQL concurrent sandbox settlement');
  expect(result.stdout).toContain('PASS real PostgreSQL concurrent model hold/refund settlement');
  expect(result.status).toBe(0);
}, 50000);