import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const maybeSingle = jest.fn(async () => ({
  data: {
    id: 'requirement-1',
    backlog: {
      schema_version: 1,
      items: [],
      current_phase_id: 'build',
      completion_ratio: 0,
      cycles_spent_total: 0,
    },
    progress: [],
    metadata: {},
  },
  error: null,
}));
const eqAfterSelect = jest.fn(() => ({ maybeSingle }));
const select = jest.fn(() => ({ eq: eqAfterSelect }));
const updateEq = jest.fn(async () => ({ error: null }));
const update = jest.fn(() => ({ eq: updateEq }));
const patchRequirementMetadataKeys = jest.fn(async () => ({
  decisions_log: [],
  concurrent_key: 'preserved',
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({ select, update })),
  },
}));

jest.mock('../requirement-metadata-patch', () => ({
  patchRequirementMetadataKeys,
}));

describe('syncGroundTruthBeforeCommit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refreshes the backlog mirror without appending progress for a clean checkpoint', async () => {
    const runCommand = jest.fn(async () => ({
      exitCode: 0,
      stdout: async () => Buffer.from(''),
      stderr: async () => Buffer.from(''),
    }));
    const { syncGroundTruthBeforeCommit } = await import('../requirement-ground-truth');

    await syncGroundTruthBeforeCommit({
      sandbox: { runCommand } as any,
      cwd: '/vercel/sandbox',
      requirementId: 'requirement-1',
      appendProgress: false,
    });

    expect(maybeSingle).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not append progress when the refreshed workspace remains clean', async () => {
    const runCommand = jest.fn(async (input: { cmd: string }) => ({
      exitCode: 0,
      stdout: async () => Buffer.from(input.cmd === 'git' ? '' : ''),
      stderr: async () => Buffer.from(''),
    }));
    const { syncGroundTruthBeforeCommit } = await import('../requirement-ground-truth');

    await syncGroundTruthBeforeCommit({
      sandbox: { runCommand } as any,
      cwd: '/vercel/sandbox',
      requirementId: 'requirement-1',
      appendProgress: 'if-workspace-dirty',
    });

    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(update).not.toHaveBeenCalled();
  });

  it('appends progress when code or the refreshed backlog is dirty', async () => {
    const runCommand = jest.fn(async (input: { cmd: string; args?: string[] }) => {
      const isStatus = input.cmd === 'git';
      const isRead = input.cmd === 'sh' && input.args?.[1]?.includes('__MISSING__');
      return {
        exitCode: 0,
        stdout: async () => Buffer.from(isStatus ? ' M feature_list.json\n' : isRead ? '__MISSING__\n' : ''),
        stderr: async () => Buffer.from(''),
      };
    });
    const { syncGroundTruthBeforeCommit } = await import('../requirement-ground-truth');

    await syncGroundTruthBeforeCommit({
      sandbox: { runCommand } as any,
      cwd: '/vercel/sandbox',
      requirementId: 'requirement-1',
      note: 'checkpoint',
      appendProgress: 'if-workspace-dirty',
    });

    expect(maybeSingle).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('patches only decisions_log so unrelated concurrent metadata survives', async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'requirement-1',
        backlog: {
          schema_version: 1,
          items: [],
          current_phase_id: 'build',
          completion_ratio: 0,
          cycles_spent_total: 0,
        },
        progress: [],
        metadata: {
          decisions_log: [{ ts: '2026-09-17T00:00:00.000Z', decision: 'Existing', reason: 'Recorded' }],
          stale_snapshot_key: 'must-not-be-written',
        },
      },
      error: null,
    });
    const { appendDecision } = await import('../requirement-ground-truth');

    await appendDecision({
      requirementId: 'requirement-1',
      decision: {
        ts: '2026-09-17T01:00:00.000Z',
        decision: 'Use atomic metadata patches',
        reason: 'Preserve unrelated concurrent keys',
      },
    });

    expect(patchRequirementMetadataKeys).toHaveBeenCalledWith({
      requirementId: 'requirement-1',
      patch: {
        decisions_log: [
          { ts: '2026-09-17T00:00:00.000Z', decision: 'Existing', reason: 'Recorded' },
          {
            ts: '2026-09-17T01:00:00.000Z',
            decision: 'Use atomic metadata patches',
            reason: 'Preserve unrelated concurrent keys',
          },
        ],
      },
    });
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.anything() }),
    );
  });

  it('invalidates passing test receipts when a later change set is captured', async () => {
    const { mergeEvidenceRecords } = await import('../requirement-ground-truth');
    const previous = {
      schema_version: 1 as const,
      item_id: 'item-1',
      evidence_run_id: 'run-1',
      captured_at: '2026-09-18T00:00:00.000Z',
      critic_passes: 0,
      judge_verdict: 'approved' as const,
      tests: [{
        command: 'npm test -- assets.test.ts',
        exit_code: 0,
        output_tail: 'PASS',
        ran_after_changes: true,
        captured_at: '2026-09-18T00:01:00.000Z',
      }],
    };
    const next = {
      schema_version: 1 as const,
      item_id: 'item-1',
      evidence_run_id: 'run-2',
      captured_at: '2026-09-18T00:02:00.000Z',
      build: {
        command: 'npm run build',
        exit_code: 0,
        duration_ms: 100,
      },
      changed_files: ['src/app/api/assets/route.ts'],
      critic_passes: 0,
    };

    const merged = mergeEvidenceRecords(previous, next);
    expect(merged).toEqual(
      expect.objectContaining({
        tests: undefined,
        build: next.build,
      }),
    );
    expect(merged.judge_verdict).toBeUndefined();
  });

  it('preserves current receipts across writes in the same evidence run', async () => {
    const { mergeEvidenceRecords } = await import('../requirement-ground-truth');
    const previous = {
      schema_version: 1 as const,
      item_id: 'item-1',
      evidence_run_id: 'run-1',
      captured_at: '2026-09-18T00:00:00.000Z',
      critic_passes: 0,
      tests: [{
        command: 'npm test',
        exit_code: 0,
        output_tail: 'PASS',
        ran_after_changes: true,
      }],
    };
    const next = {
      schema_version: 1 as const,
      item_id: 'item-1',
      evidence_run_id: 'run-1',
      captured_at: '2026-09-18T00:01:00.000Z',
      changed_files: ['src/app/page.tsx'],
      critic_passes: 1,
    };

    expect(mergeEvidenceRecords(previous, next).tests).toEqual(previous.tests);
  });

  it('deduplicates receipts by step, command, and workspace fingerprint', async () => {
    const { mergeEvidenceRecords } = await import('../requirement-ground-truth');
    const base = {
      schema_version: 1 as const,
      item_id: 'item-1',
      evidence_run_id: 'run-1',
      captured_at: '2026-09-18T00:00:00.000Z',
      critic_passes: 0,
      tests: [{
        command: 'npm test',
        exit_code: 0,
        output_tail: 'first run',
        ran_after_changes: true,
        captured_at: '2026-09-18T00:00:00.000Z',
        step_id: 'step-1',
        workspace_fingerprint: 'a'.repeat(40),
      }],
    };
    const merged = mergeEvidenceRecords(base, {
      schema_version: 1,
      item_id: 'item-1',
      evidence_run_id: 'run-1',
      captured_at: '2026-09-18T00:01:00.000Z',
      tests: [{
        ...base.tests[0],
        output_tail: 'reused run',
        captured_at: '2026-09-18T00:01:00.000Z',
      }],
    });

    expect(merged.tests).toEqual([
      expect.objectContaining({ output_tail: 'reused run' }),
    ]);
  });

  it('invalidates cached gates when a tool receipt has a new fingerprint', async () => {
    const { mergeEvidenceRecords } = await import('../requirement-ground-truth');
    const merged = mergeEvidenceRecords({
      schema_version: 1,
      item_id: 'item-1',
      workspace_fingerprint: 'a'.repeat(40),
      captured_at: '2026-09-18T00:00:00.000Z',
      critic_passes: 0,
      build: {
        command: 'npm run build',
        exit_code: 0,
        duration_ms: 1,
      },
    }, {
      schema_version: 1,
      item_id: 'item-1',
      producer_step_id: 'step-1',
      workspace_fingerprint: 'b'.repeat(40),
      captured_at: '2026-09-18T00:01:00.000Z',
      tests: [{
        command: 'npm test',
        exit_code: 0,
        output_tail: 'PASS',
        ran_after_changes: true,
        step_id: 'step-1',
        workspace_fingerprint: 'b'.repeat(40),
      }],
    });

    expect(merged.build).toBeUndefined();
    expect(merged.tests).toHaveLength(1);
  });

  it('does not erase prior evidence with undefined fields during re-adjudication', async () => {
    const { mergeEvidenceRecords } = await import('../requirement-ground-truth');
    const previous = {
      schema_version: 1 as const,
      item_id: 'item-1',
      evidence_run_id: 'run-1',
      captured_at: '2026-09-18T00:00:00.000Z',
      critic_passes: 0,
      build: {
        command: 'npm run build',
        exit_code: 0,
        duration_ms: 100,
      },
    };

    expect(mergeEvidenceRecords(previous, {
      schema_version: 1,
      item_id: 'item-1',
      evidence_run_id: 'run-1',
      captured_at: '2026-09-18T00:02:00.000Z',
      build: undefined,
      critic_passes: 1,
    }).build).toEqual(previous.build);
  });
});
