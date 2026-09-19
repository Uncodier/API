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

  it('preserves passing test receipts across later gate writes', async () => {
    const { mergeEvidenceRecords } = await import('../requirement-ground-truth');
    const previous = {
      schema_version: 1 as const,
      item_id: 'item-1',
      captured_at: '2026-09-18T00:00:00.000Z',
      critic_passes: 0,
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
      captured_at: '2026-09-18T00:02:00.000Z',
      build: {
        command: 'npm run build',
        exit_code: 0,
        duration_ms: 100,
      },
      critic_passes: 0,
    };

    expect(mergeEvidenceRecords(previous, next)).toEqual(
      expect.objectContaining({
        tests: previous.tests,
        build: next.build,
      }),
    );
  });
});
