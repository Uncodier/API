import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
it('executes the actual forward migration offline with receipt identity and service ACLs', () => {
  const child = spawnSync(process.execPath, [resolve(process.cwd(), 'src/app/api/site/setup/email/__tests__/receipt-sql-runner.mjs')], { encoding: 'utf8', timeout: 90_000 });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || child.error?.message);
  expect(child.stdout).toContain('Validated 7 durable setup email SQL scenarios');
}, 100_000);
it('proves real concurrent transactions block and never acquire/resend twice on disposable PostgreSQL', () => {
  const child = spawnSync(process.execPath, [resolve(process.cwd(), 'src/app/api/site/setup/email/__tests__/receipt-concurrency-runner.mjs')], { encoding: 'utf8', timeout: 90_000 });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || child.error?.message);
  expect(child.stdout).toContain('Validated 4 real PostgreSQL setup email concurrency scenarios');
}, 100_000);