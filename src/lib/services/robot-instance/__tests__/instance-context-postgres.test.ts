import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('instance context PostgreSQL invariants', () => {
  it('verifies cursor CAS, queued actions, same timestamps, RPC grants and cross-site RLS', () => {
    const output = execFileSync(process.execPath, [resolve(process.cwd(),
      'src/lib/services/robot-instance/__tests__/instance-context-postgres-runner.mjs')],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    expect(output).toContain('pgvector substituted');
  });
});