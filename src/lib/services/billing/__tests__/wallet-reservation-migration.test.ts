import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('executes latest core then wallet reservations against offline PostgreSQL semantics', () => {
  const run = spawnSync(process.execPath, [resolve(__dirname, 'wallet-reservation-postgres-runner.mjs')], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' },
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || String(run.error));
  expect(run.stdout).toContain('passed 33 wallet reservation SQL checks');
}, 100000);