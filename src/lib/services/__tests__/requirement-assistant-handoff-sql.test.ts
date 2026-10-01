import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('arbitrates original assistant and cron ownership in isolated PostgreSQL', () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(),
    'src/lib/services/__tests__/requirement-assistant-handoff-postgres-runner.mjs')], {
    cwd: process.cwd(), timeout: 60_000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect(output).toContain('PASS PostgreSQL assistant handoff');
}, 65_000);