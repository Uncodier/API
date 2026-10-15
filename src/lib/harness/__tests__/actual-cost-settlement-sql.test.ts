import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('atomically settles authoritative OpenRouter cost against real billing bucket fixtures offline', () => {
  const result = spawnSync(process.execPath, [resolve(__dirname, 'actual-cost-settlement-runner.mjs')], {
    cwd: resolve(__dirname, '../../../..'), encoding: 'utf8', timeout: 60000,
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('11 offline actual-cost PostgreSQL checks passed');
}, 65000);