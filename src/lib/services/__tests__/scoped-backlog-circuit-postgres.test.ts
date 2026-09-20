import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('block_backlog_item_for_circuit_atomic PostgreSQL behavior', () => {
  it('rejects a backlog item that is not bound to the selected step', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        resolve(
          process.cwd(),
          'src/lib/services/__tests__/scoped-backlog-circuit-postgres-runner.mjs',
        ),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(output);
    expect(result.rpc).toMatchObject({ state: 'stale' });
    expect(result.backlogRevision).toBe(0);
    expect(result.items).toEqual([
      { id: 'item-a', status: 'in_progress' },
      { id: 'item-b', status: 'pending' },
    ]);
    expect(result.overloads).toEqual({
      block_requirement_for_product_no_progress: 2,
      record_requirement_cron_cycle_outcome: 2,
    });
    expect(result.cleanupOnlyLegacyScope).toMatchObject({
      accepted: false,
      is_latest: false,
      recorded_outcome: 'product_no_progress',
      plan_id: null,
      step_id: null,
    });
    expect(result.legacyNoProgressScope).toEqual({
      plan_id: '50000000-0000-4000-8000-000000000005',
      step_id: 'replacement-step',
    });
    expect(result.legacyProgressScope).toEqual({
      plan_id: '50000000-0000-4000-8000-000000000005',
      step_id: 'replacement-step',
    });
    expect(result.overlappingLegacyScope).toMatchObject({
      accepted: false,
      is_latest: false,
      recorded_outcome: 'product_no_progress',
      plan_id: null,
      step_id: null,
    });
    expect(result.missingLegacyScope).toMatchObject({
      accepted: false,
      is_latest: false,
      recorded_outcome: 'product_no_progress',
      plan_id: null,
      step_id: null,
    });
    expect(result.atomicCancellation).toEqual({
      plans_touched: 1,
      plans_cancelled: 0,
      steps_cancelled: 1,
      plan_ids: ['50000000-0000-4000-8000-000000000005'],
      errors: [],
    });
    expect(result.cancelledPlan).toMatchObject({
      status: 'in_progress',
      steps: [
        expect.objectContaining({
          id: 'replacement-step',
          status: 'cancelled',
        }),
        expect.objectContaining({
          id: 'retryable-step',
          status: 'failed',
          retry_count: 1,
        }),
      ],
    });
  });
});
