import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), 'scripts/retire-legacy-migration-holds.ts');
const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', file, ...args], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
  env: { PATH: process.env.PATH, NODE_ENV: 'test' }, // No live environment/credentials.
});

it('shows operator scope and no fake SQL/worker success without credentials', () => {
  const result = run(['--help']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--apply');
  expect(result.stdout).toContain('Never applies or validates SQL');
  expect(result.stdout).toContain('unarchives owners');
});

it.each([
  ['--resume'],
  ['--all', '--all'],
  ['--project=bad', '--all'],
  ['--project=rnjgeloamtszdjplmqxy', '--all', '--operator=offline', '--reason=Retire obsolete authority'],
  ['--sql=SELECT 1'],
  ['--reset'],
].map(args => ({ args })))('fails closed on missing credentials or invalid flags (%#)', ({ args }) => {
  const result = run(args);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Legacy retirement failed');
  expect(result.stderr).not.toContain('SELECT 1');
});