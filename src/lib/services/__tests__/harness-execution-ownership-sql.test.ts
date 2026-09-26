import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('executes the forward scheduler repair in in-memory PostgreSQL', () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(),
    'src/lib/services/__tests__/harness-execution-ownership-postgres-runner.mjs')], {
    cwd: process.cwd(), timeout: 60_000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect(output).toContain('PASS real PostgreSQL scheduler/ownership');
}, 65_000);