import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('retires legacy authority with immutable audit, CAS and unchanged SQL history in PostgreSQL', () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(),
    'src/app/api/cron/shared/__tests__/migration-retirement-postgres-runner.mjs')], {
    cwd: process.cwd(), timeout: 60_000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect(output).toContain('PASS migration retirement PostgreSQL guards');
}, 65_000);