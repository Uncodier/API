import { describe, expect, it } from '@jest/globals';
import {
  extractRepairActionReceipts,
  formatRepairRunFeedback,
  materialHealingApplied,
  planJudgeRepair,
  recordJudgeRepairAttempt,
  startJudgeRepairRun,
} from '../judge-repair-controller';

describe('judge repair controller', () => {
  it('turns mixed diagnostics into scoped typed actions', () => {
    const run = planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Acceptance evidence is incomplete.',
        matched_acceptance: [],
        unmatched_acceptance: ['POST persists photos'],
        failure_kind: 'contract_error',
        acceptance_diagnostics: [{
          criterion_id: 'criterion-1',
          criterion: 'POST persists photos',
          status: 'missing',
          claims: [],
          gaps: [{
            code: 'inferred_target_unconfirmed',
            class: 'contract',
            message: 'POST lacks a declared fixture.',
            required: 'POST /api/evidence with payload',
            suggested_action: 'Declare POST, its payload fixture, and persistence assertion.',
          }, {
            code: 'missing_semantic_receipt',
            class: 'evidence',
            message: 'No DOM receipt.',
            required: 'mobile upload input',
            suggested_action: 'Capture the typed DOM assertion.',
          }],
        }],
      },
      evidenceRunId: 'evidence-1',
      acceptanceContract: { schema_version: 2 },
      createdAt: '2026-09-25T00:00:00.000Z',
      repairRunId: 'repair-1',
    });

    expect(run).toMatchObject({
      status: 'planned',
      repair_run_id: 'repair-1',
      source_evidence_run_id: 'evidence-1',
      max_attempts: 6,
      actions: [
        { kind: 'repair_contract', gap_code: 'inferred_target_unconfirmed' },
        { kind: 'collect_evidence', gap_code: 'missing_semantic_receipt' },
      ],
    });
    expect(formatRepairRunFeedback(run!)).toContain('not yet applied');
  });

  it('does not claim healing from a planned action or reused evidence', () => {
    const run = planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Missing evidence.',
        matched_acceptance: [],
        unmatched_acceptance: ['GET / works'],
        failure_kind: 'evidence_gap',
      },
      evidenceRunId: 'evidence-1',
      repairRunId: 'repair-1',
    });
    expect(materialHealingApplied({
      run,
      newEvidenceRunId: 'evidence-2',
      sourceEvidenceRunId: 'evidence-1',
    })).toBeUndefined();
    expect(materialHealingApplied({
      run: { ...run!, status: 'materialized' },
      newEvidenceRunId: 'evidence-1',
      sourceEvidenceRunId: 'evidence-1',
    })).toBeUndefined();
  });

  it('recognizes a material evidence repair only with a fresh evidence run', () => {
    const run = planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Missing evidence.',
        matched_acceptance: [],
        unmatched_acceptance: ['GET / works'],
        failure_kind: 'evidence_gap',
      },
      evidenceRunId: 'evidence-1',
      repairRunId: 'repair-1',
    });
    const inProgress = startJudgeRepairRun(run!);
    const receipts = extractRepairActionReceipts({
      run: inProgress,
      actionId: inProgress.actions[0].action_id,
      attemptedAt: '2026-09-25T00:01:00.000Z',
      result: {
        steps: [{
          toolCalls: [{
            toolCallId: 'call-1',
            toolName: 'sandbox_run_command',
            args: { command: 'npm test -- evidence' },
          }],
          toolResults: [{
            toolCallId: 'call-1',
            result: { exitCode: 0, stdout: 'captured' },
          }],
        }],
      },
    });
    const materialized = recordJudgeRepairAttempt({
      run: inProgress,
      receipts,
      workspaceChanged: false,
      contractRevision: inProgress.contract_revision,
    });
    expect(materialized).toMatchObject({
      repair_run_id: 'repair-1',
      status: 'materialized',
      attempt_count: 1,
    });
    expect(receipts[0]).toMatchObject({
      action_digest: expect.any(String),
      tool_arguments_excerpt: expect.stringContaining('npm test'),
    });
    expect(materialHealingApplied({
      run: materialized,
      newEvidenceRunId: 'evidence-2',
      sourceEvidenceRunId: 'evidence-1',
      evidenceCaptured: true,
    })).toBe('collect_evidence');
  });

  it('records failed receipts and exhausts the same run at max_attempts', () => {
    const planned = planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Capability unavailable.',
        matched_acceptance: [],
        unmatched_acceptance: ['Browser available'],
        failure_kind: 'capability_gap',
      },
      evidenceRunId: 'evidence-1',
      repairRunId: 'repair-1',
    })!;
    const run = startJudgeRepairRun(planned);
    const receipts = extractRepairActionReceipts({
      run,
      actionId: run.actions[0].action_id,
      result: {
        steps: [{
          toolCalls: [{ id: 'call-1', toolName: 'sandbox_run_command' }],
          toolResults: [{
            toolCallId: 'call-1',
            cleanedResult: { success: false, error: 'browser missing' },
          }],
        }],
      },
    });
    const exhausted = recordJudgeRepairAttempt({
      run,
      receipts,
      workspaceChanged: false,
      contractRevision: run.contract_revision,
    });
    expect(receipts).toEqual([
      expect.objectContaining({
        repair_run_id: 'repair-1',
        action_id: run.actions[0].action_id,
        status: 'failed',
      }),
    ]);
    expect(exhausted).toMatchObject({
      repair_run_id: 'repair-1',
      status: 'exhausted',
      attempt_count: 1,
    });
  });

  it('does not create a receipt from prose or an unmatched tool result', () => {
    const run = startJudgeRepairRun(planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Missing evidence.',
        matched_acceptance: [],
        unmatched_acceptance: ['GET / works'],
        failure_kind: 'evidence_gap',
      },
      repairRunId: 'repair-1',
    })!);
    expect(extractRepairActionReceipts({
      run,
      actionId: run.actions[0].action_id,
      result: {
        steps: [{
          toolCalls: [{ id: 'call-1', toolName: 'sandbox_run_command' }],
          toolResults: [{ toolCallId: 'different-call', result: { exitCode: 0 } }],
        }],
      },
    })).toEqual([]);
  });

  it('records an ambiguous matched result as failed rather than successful', () => {
    const run = startJudgeRepairRun(planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Missing evidence.',
        matched_acceptance: [],
        unmatched_acceptance: ['GET / works'],
        failure_kind: 'evidence_gap',
      },
      repairRunId: 'repair-1',
    })!);

    expect(extractRepairActionReceipts({
      run,
      actionId: run.actions[0].action_id,
      result: {
        steps: [{
          toolCalls: [{
            id: 'call-1',
            toolName: 'sandbox_run_command',
            args: { command: 'echo ok' },
          }],
          toolResults: [{ toolCallId: 'call-1', result: { output: 'ok' } }],
        }],
      },
    })).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });

  it('does not attribute an unrelated read-only tool to an evidence action', () => {
    const run = startJudgeRepairRun(planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Missing evidence.',
        matched_acceptance: [],
        unmatched_acceptance: ['GET / works'],
        failure_kind: 'evidence_gap',
      },
      repairRunId: 'repair-1',
    })!);

    expect(extractRepairActionReceipts({
      run,
      actionId: run.actions[0].action_id,
      result: {
        steps: [{
          toolCalls: [{ id: 'call-1', toolName: 'sandbox_read_file' }],
          toolResults: [{
            toolCallId: 'call-1',
            result: { success: true, content: 'unrelated source' },
          }],
        }],
      },
    })).toEqual([]);
  });

  it('rejects ambiguous multi-tool attribution for one repair action', () => {
    const run = startJudgeRepairRun(planJudgeRepair({
      judge: {
        verdict: 'rejected',
        reason: 'Missing evidence.',
        matched_acceptance: [],
        unmatched_acceptance: ['GET / works'],
        failure_kind: 'evidence_gap',
      },
      repairRunId: 'repair-1',
    })!);

    expect(extractRepairActionReceipts({
      run,
      actionId: run.actions[0].action_id,
      result: {
        steps: [{
          toolCalls: [
            { id: 'call-1', toolName: 'sandbox_run_command' },
            { id: 'call-2', toolName: 'sandbox_browser_probe' },
          ],
          toolResults: [
            { toolCallId: 'call-1', result: { exitCode: 0 } },
            { toolCallId: 'call-2', result: { success: true } },
          ],
        }],
      },
    })).toEqual([]);
  });
});