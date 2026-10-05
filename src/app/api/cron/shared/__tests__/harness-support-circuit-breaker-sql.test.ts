import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Child process avoids Jest ESM/WASM loader limitations. The runner is also
// directly executable with node; no application imports, .env or live database.
it('enforces the host-only support circuit-breaker SQL contract offline', () => {
  const result = spawnSync(process.execPath, [resolve(__dirname, 'harness-support-circuit-breaker-postgres-runner.mjs')], {
    cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr?.slice(-8_000) || result.error?.message || 'Offline support circuit-breaker checks failed');
  const passed = JSON.parse(result.stdout);
  expect(passed).toHaveLength(15);
}, 95_000);