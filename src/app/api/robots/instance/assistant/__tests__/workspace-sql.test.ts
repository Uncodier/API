import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('executes the workspace resource migration in disposable PostgreSQL without application sessions', () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(),
    'src/lib/services/billing/__tests__/assistant-workspace-sql-runner.mjs')], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect(output).toContain('Assistant workspace PostgreSQL: scope, exclusive lease, sticky initialization, ACL and billing passed');
}, 65000);