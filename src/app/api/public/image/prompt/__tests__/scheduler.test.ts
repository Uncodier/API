import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('executes the real installed SDK retry contract and production workflow offline', () => {
  const output = execFileSync(process.execPath, [resolve('src/app/api/public/image/prompt/__tests__/scheduler-offline.mjs')], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    // Do not inherit provider configuration, credentials, or a real Workflow world.
    env: { PATH: process.env.PATH, NODE_ENV: 'test', WORKFLOW_LOG_LEVEL: 'silent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(output).toContain('offline SDK scheduler: paid failures/completion loss never replay');
});