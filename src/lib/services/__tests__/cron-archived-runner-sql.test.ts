import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('replaces only explicitly archived owners atomically without resetting work or security in PostgreSQL', () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(),
    'src/lib/services/__tests__/archived-runner-postgres-runner.mjs')], {
    cwd: process.cwd(), timeout: 60_000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect(output).toContain('PASS PostgreSQL archived runner replacement');
}, 65_000);