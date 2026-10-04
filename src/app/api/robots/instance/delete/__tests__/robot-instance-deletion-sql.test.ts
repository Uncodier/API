import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('deletes only canonical quiescent instance requirements atomically in isolated PostgreSQL', () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(),
    'src/app/api/robots/instance/delete/__tests__/deletion-postgres-runner.mjs')], {
    cwd: process.cwd(), timeout: 90_000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect(output).toContain('PASS PostgreSQL atomic robot instance deletion');
}, 95_000);