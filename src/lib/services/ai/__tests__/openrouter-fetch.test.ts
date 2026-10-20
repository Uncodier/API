import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('uses platform fetch for the bundled real SDK, including JSON, SSE, deadlines and aborts', () => {
  const child = spawnSync(process.execPath, ['--trace-deprecation', resolve(__dirname, 'openrouter-fetch-runner.mjs')], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || child.error?.message);
  expect(child.stdout).toContain('Validated 8 native OpenRouter transport scenarios');
  expect(child.stderr).not.toContain('DEP0169');
}, 25_000);