import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('serializes wallet consumption, holds, refunds and real payout debits on a private PostgreSQL cluster', () => {
  const run = spawnSync(process.execPath, [resolve(__dirname, 'wallet-concurrency-runner.mjs')], {
    encoding: 'utf8',
    timeout: 120000,
    // Do not inherit developer .env, PG settings, credentials or Node preload hooks.
    env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`${run.stdout}\n${run.stderr}\n${run.error || ''}`);
  expect(run.stdout.match(/^PASS real PostgreSQL /gm)).toHaveLength(29);
  expect(run.stdout.match(/^LOCK .*wait_event_type=Lock, blocked by first transaction$/gm)).toHaveLength(26);
  expect(run.stdout).toContain('passed 29 wallet concurrency checks; proved 26 actual lock waits');
  expect(run.stdout).toContain('CLEANUP private PostgreSQL cluster stopped and removed');
}, 130000);