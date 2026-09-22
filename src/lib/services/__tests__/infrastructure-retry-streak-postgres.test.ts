import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('infrastructure retry streak PostgreSQL behavior', () => {
  it('reopens accumulated false blocks and resets on remediation', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        resolve(
          process.cwd(),
          'src/lib/services/__tests__/infrastructure-retry-streak-postgres-runner.mjs',
        ),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(output);

    expect(result.repaired).toEqual({
      status: 'in-progress',
      retry_streak: '1',
      blocker: null,
    });
    expect(result.audit).toEqual({
      stage: 'in-progress',
      cycle: 'infrastructure-counter-normalization-v2',
    });
    expect(result.remediation).toMatchObject({
      accepted: true,
      is_latest: true,
      recorded_outcome: 'remediation_handoff',
      infrastructure_failure_cycles: 0,
    });
    expect(result.retry).toMatchObject({
      accepted: true,
      is_latest: true,
      recorded_outcome: 'infrastructure_retry',
      infrastructure_failure_cycles: 1,
    });
  });
});
