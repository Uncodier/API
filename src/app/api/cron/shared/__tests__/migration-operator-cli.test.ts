import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../../../..');
const script = resolve(root, 'scripts/reconcile-requirement-migration.ts');
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath,
  ['--import', 'tsx', script, ...args], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { NODE_ENV: 'test', PATH: process.env.PATH, ...env } });

it('prints help without credentials or network and rejects no-argument/duplicate/resume-only calls', () => {
  expect(run(['--help']).stdout).toContain('dry-run by default');
  for (const args of [[], ['--apply', '--apply'], ['--resume'], ['--unknown=value']]) {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Migration reconciliation failed.');
  }
});

it('rejects misbound authenticated URLs without echoing credentials or arguments', () => {
  const username = randomBytes(16).toString('hex');
  const password = randomBytes(16).toString('hex');
  const serviceKey = randomBytes(32).toString('hex');
  const url = new URL('https://database.example.test');
  url.username = username; url.password = password;
  const result = run(['--makinari-project=' + 'a'.repeat(20), '--apps-project=' + 'b'.repeat(20),
    '--requirement=00000000-0000-4000-8000-000000000001', '--instance=00000000-0000-4000-8000-000000000002',
    '--plan=00000000-0000-4000-8000-000000000003', '--request=00000000-0000-4000-8000-000000000004',
    '--step=step_1', '--file=migrations/0001.sql', '--operator=operator', '--reason=Reconcile stale plan hold'],
  { SUPABASE_URL: url.href, SUPABASE_SERVICE_ROLE_KEY: serviceKey });
  expect(result.status).toBe(1);
  for (const secret of [username, password, serviceKey]) expect(result.stdout + result.stderr).not.toContain(secret);
});