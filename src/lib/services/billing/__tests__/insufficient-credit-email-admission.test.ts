import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('insufficient-credit email admission (offline PostgreSQL)', () => {
  it('executes the migration with owner-bound rolling gates and service-only access', () => {
    const child = spawnSync(process.execPath, [resolve(__dirname,
      'insufficient-credit-email-admission.mjs')], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
      // Never inherit database URLs, provider credentials or developer .env.
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
    expect(child.stdout).toContain('Validated 14 insufficient-credit email admission scenarios');
    expect(child.stdout).toContain('stale captured owner sites deny without any reservation');
    expect(child.stdout).toContain('PGlite serializes Promise.all; not true multi-connection concurrency');
  }, 100_000);
});