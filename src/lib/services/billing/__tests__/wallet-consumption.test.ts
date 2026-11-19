import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('consumes withdrawable funds atomically after regular credits (offline PostgreSQL)', () => {
  const child = spawnSync(process.execPath, [resolve(process.cwd(),
    'src/lib/services/billing/__tests__/wallet-consumption-runner.mjs')], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
  expect(child.stdout).toContain('Validated 12 withdrawable consumption scenarios');
}, 100_000);