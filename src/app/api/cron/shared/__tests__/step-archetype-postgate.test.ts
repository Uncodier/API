import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const asyncMock = () => jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const syncMock = () => jest.fn() as jest.MockedFunction<
  (...args: any[]) => any
>;
const getBacklogItem = asyncMock();
const recordToolFailure = asyncMock();
const markNeedsReview = asyncMock();
const writeEvidence = asyncMock();
const runJudge = syncMock();
const runCritic = syncMock();
const logCronInfrastructureEvent = asyncMock();
const computeFeatureCoverage = asyncMock();
const patchPlanStepAtomically = asyncMock();

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

jest.mock('@/lib/services/requirement-backlog', () => ({
  bumpItemAttempts: jest.fn(),
  getBacklogItem,
  downgradeScope: jest.fn(),
  logAssumption: jest.fn(),
  markNeedsReview,
  recordToolFailure,
}));

jest.mock('@/lib/services/requirement-ground-truth', () => ({
  writeEvidence,
}));

jest.mock('../archetype-runner', () => ({
  runCritic,
  runJudge,
}));

jest.mock('@/lib/services/requirement-self-heal', () => ({
  planNextHealingAction: jest.fn(),
}));

jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: { STEP_STATUS: 'step_status' },
  logCronInfrastructureEvent,
}));

jest.mock('../feature-coverage', () => ({
  computeFeatureCoverage,
  summarizeFeatureCoverage: jest.fn(() => 'coverage_ok'),
}));

jest.mock('../step-runtime-targets', () => ({
  inferTargetRoutesFromDiff: jest.fn(async () => ({ changedFiles: [] })),
}));

jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({
  patchPlanStepAtomically,
}));

import { runArchetypePostGate } from '../step-archetype-postgate';
import { persistJudgeRejection } from '../single-turn-judge-rejection';
import { missingTestEvidenceResult } from '../judge-test-repair';
import {
  planJudgeRepair,
  recordJudgeRepairAttempt,
  type JudgeRepairRun,
} from '../judge-repair-controller';

const item = {
  id: 'item-1',
  title: 'Navigation',
  kind: 'polish',
  phase_id: 'build',
  status: 'in_progress',
  scope_level: 'full',
  acceptance: ['Footer links resolve'],
  attempts: 0,
  tier: 'core',
};

function input() {
  return {
    sandbox: {} as any,
    requirementId: 'requirement-1',
    backlogItemId: 'item-1',
    stepId: 'step-1',
    signals: {
      build: { ok: true },
      changed_files: ['src/app/layout.tsx'],
    },
    capturedAt: '2026-09-21T18:45:25.277Z',
    evidenceRunId: 'evidence-run-1',
    audit: {} as any,
  };
}

function appliedRepair(run: JudgeRepairRun): JudgeRepairRun {
  const attempt = (run.attempt_count || 0) + 1;
  return recordJudgeRepairAttempt({
    run,
    workspaceChanged: true,
    contractRevision: run.contract_revision,
    receipts: [{
      receipt_id: `receipt-${attempt}`,
      repair_run_id: run.repair_run_id,
      action_id: run.actions[0].action_id,
      attempt,
      tool_call_id: `call-${attempt}`,
      tool_name: 'sandbox_run_command',
      status: 'succeeded',
      attempted_at: '2026-09-21T18:45:00.000Z',
    }],
  });
}

describe('runArchetypePostGate verification budget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    computeFeatureCoverage.mockResolvedValue({
      ok: true,
      evaluable: true,
      declared_touches: [],
      present_touches: [],
      missing_touches: [],
      not_evaluable_touches: [],
      expected_page_routes: [],
      expected_api_routes: [],
      present_page_files: [],
      present_api_files: [],
      not_evaluable_page_routes: [],
      not_evaluable_api_routes: [],
      acceptance_route_anchors: [],
      artifact_proofs: [],
      kind_requirements: [],
      probe_errors: [],
    });
    getBacklogItem.mockResolvedValue({ kind: 'app', item });
    writeEvidence.mockImplementation(async ({ itemId, record }: any) => ({
      schema_version: 1,
      item_id: itemId,
      critic_passes: 0,
      ...record,
    }));
    runCritic.mockReturnValue({ ok: true, iterations: 1, suggestions: [] });
    runJudge.mockReturnValue({
      verdict: 'rejected',
      reason: 'Footer link proof is missing.',
      matched_acceptance: [],
      unmatched_acceptance: ['Footer links resolve'],
      failure_kind: 'evidence_gap',
    });
    logCronInfrastructureEvent.mockResolvedValue(undefined);
  });

  it('returns actionable repair feedback before the limit', async () => {
    recordToolFailure.mockResolvedValue({
      ...item,
      tool_failures: { judge_evidence_collector: 2 },
    });

    const result = await runArchetypePostGate(input());
    expect(result).toMatchObject({
      ran: true,
      judge_verdict: 'rejected',
      judge_failure_kind: 'evidence_gap',
      verification_exhausted: false,
      repair_feedback: expect.stringContaining('Footer links resolve'),
      repair_planned: expect.objectContaining({
        status: 'planned',
        failure_kind: 'evidence_gap',
        source_evidence_run_id: 'evidence-run-1',
        actions: [expect.objectContaining({ kind: 'collect_evidence' })],
      }),
    });
    expect(result.healing_applied).toBeUndefined();
    expect(result.repair_feedback).toContain('Repair run: planned (not yet applied)');
    expect(markNeedsReview).not.toHaveBeenCalled();
    expect(recordToolFailure).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'judge_evidence_collector',
    }));
  });

  it('resets repair state when the new Judge produces a different diagnostic', async () => {
    recordToolFailure.mockResolvedValue({
      ...item,
      tool_failures: { judge_evidence_collector: 2 },
    });
    const result = await runArchetypePostGate({
      ...input(),
      repairRun: {
        schema_version: 1,
        diagnostic_id: 'diagnostic-old',
        repair_run_id: 'repair-stable',
        status: 'materialized',
        failure_kind: 'evidence_gap',
        source_evidence_run_id: 'evidence-old',
        contract_revision: 'contract-1',
        created_at: '2026-09-25T00:00:00.000Z',
        max_attempts: 3,
        attempt_count: 1,
        actions: [{
          action_id: 'action-old',
          kind: 'collect_evidence',
          instruction: 'Capture proof.',
          verification: 'Run probe.',
        }],
        action_receipts: [{
          receipt_id: 'receipt-old',
          repair_run_id: 'repair-stable',
          action_id: 'action-old',
          attempt: 1,
          tool_call_id: 'call-old',
          tool_name: 'sandbox_run_command',
          status: 'succeeded',
          attempted_at: '2026-09-25T00:01:00.000Z',
        }],
      },
    });

    expect(result.repair_planned).toMatchObject({
      repair_run_id: 'repair-stable',
      status: 'planned',
      attempt_count: 0,
      action_receipts: [],
    });
    expect(result.repair_planned?.actions[0].action_id).not.toContain(':round:');
    expect(writeEvidence).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        repair_provenance: {
          diagnostic_id: 'diagnostic-old',
          repair_run_id: 'repair-stable',
          source_evidence_run_id: 'evidence-old',
          action_ids: ['action-old'],
          receipt_ids: ['receipt-old'],
        },
      }),
    }));
  });

  it('assigns missing tests automatically even when older evidence-only attempts exhausted', async () => {
    const judge = missingTestEvidenceResult(item as any);
    runJudge.mockReturnValue(judge);
    recordToolFailure.mockResolvedValue({ ...item, tool_failures: { judge_evidence_collector: 5 } });
    await expect(runArchetypePostGate(input())).resolves.toMatchObject({
      verification_exhausted: false,
      repair_planned: expect.objectContaining({ status: 'planned', actions: [expect.objectContaining({ kind: 'repair_tests' })] }),
    });
    expect(markNeedsReview).not.toHaveBeenCalled();
  });

  it('does not hide a new failed Judge pass after the bounded test repair is exhausted', async () => {
    const judge = missingTestEvidenceResult(item as any);
    runJudge.mockReturnValue(judge);
    const repair = planJudgeRepair({ judge })!;
    recordToolFailure.mockResolvedValue({ ...item, tool_failures: { judge_evidence_collector: 5 } });
    markNeedsReview.mockResolvedValue({ ...item, status: 'needs_review' });
    await expect(runArchetypePostGate({ ...input(), repairRun: { ...repair, status: 'materialized', attempt_count: 3 } }))
      .resolves.toMatchObject({ verification_exhausted: true, terminal_step_status: 'cancelled' });
    expect(markNeedsReview).toHaveBeenCalledTimes(1);
  });

  it('moves only the exhausted item to review at the verification limit', async () => {
    recordToolFailure.mockResolvedValue({
      ...item,
      tool_failures: { judge_evidence_collector: 3 },
    });
    markNeedsReview.mockResolvedValue({
      ...item,
      status: 'needs_review',
    });
    patchPlanStepAtomically.mockResolvedValue({
      persisted: true,
      state: 'applied',
      generation: 5,
    });

    await expect(runArchetypePostGate(input())).resolves.toMatchObject({
      ran: true,
      repair_planned: expect.objectContaining({ status: 'exhausted' }),
      verification_exhausted: true,
      terminal_step_status: 'cancelled',
    });
    expect(markNeedsReview).toHaveBeenCalledWith(expect.objectContaining({
      requirementId: 'requirement-1',
      itemId: 'item-1',
      reason: expect.stringContaining('verification exhausted after 3 attempts'),
    }));
  });

  it('plans a harness capability repair before quarantine', async () => {
    runJudge.mockReturnValueOnce({
      verdict: 'escalate',
      reason: 'Authenticated evidence cannot be collected.',
      matched_acceptance: [],
      unmatched_acceptance: ['GET /api/account returns 200'],
      failure_kind: 'capability_gap',
      acceptance_diagnostics: [{
        criterion_id: 'criterion-1',
        criterion: 'GET /api/account returns 200',
        status: 'missing',
        claims: [],
        gaps: [{
          code: 'authentication_context_missing',
          class: 'capability',
          message: 'No authenticated context.',
          required: 'GET /api/account returns 200',
          suggested_action: 'Configure an auth profile.',
        }],
      }],
    });
    recordToolFailure.mockResolvedValue({
      ...item,
      tool_failures: { judge_capability_resolver: 1 },
    });
    await expect(runArchetypePostGate(input())).resolves.toMatchObject({
      judge_failure_kind: 'capability_gap',
      repair_planned: expect.objectContaining({
        status: 'planned',
        attempt_count: 0,
      }),
      verification_exhausted: false,
      repair_feedback: expect.stringContaining(
        'authentication_context_missing',
      ),
    });
    expect(recordToolFailure).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'judge_capability_resolver',
    }));
    expect(markNeedsReview).not.toHaveBeenCalled();
  });

  it('treats the cancellation performed by review handoff as terminal', async () => {
    recordToolFailure.mockResolvedValue({
      ...item,
      tool_failures: { judge_evidence_collector: 3 },
    });
    markNeedsReview.mockResolvedValue({
      ...item,
      status: 'needs_review',
    });

    const postGate = await runArchetypePostGate(input());
    await expect(persistJudgeRejection({
      planId: 'plan-1',
      stepId: 'step-1',
      postGate,
      effectiveSandboxId: 'sandbox-1',
      infrastructureGeneration: 4,
      executionEventId: 'cycle-1:step-1:turn-1',
    })).resolves.toMatchObject({
      ok: true,
      isDone: true,
      persistedTerminalStatus: 'cancelled',
    });
    expect(markNeedsReview).toHaveBeenCalledTimes(1);
    expect(patchPlanStepAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
  });

  it('scopes structural coverage to the current step contract', async () => {
    recordToolFailure.mockResolvedValue({
      ...item,
      tool_failures: { judge_evidence_collector: 1 },
    });

    await runArchetypePostGate({
      ...input(),
      contractAcceptance: ['GET /current-step returns 200'],
    });

    expect(computeFeatureCoverage).toHaveBeenCalledWith({
      sandbox: expect.anything(),
      item: expect.objectContaining({
        acceptance: ['GET /current-step returns 200'],
      }),
      contractScoped: true,
      changedFiles: ['src/app/layout.tsx'],
    });
  });

  it('persists real fingerprint comparisons and actionable repeated-failure feedback in repair metadata', async () => {
    recordToolFailure.mockResolvedValue({ ...item, tool_failures: { judge_evidence_collector: 2 } });
    patchPlanStepAtomically.mockResolvedValue({ persisted: true, generation: 5 });
    const gateInput = { ...input(), signals: { ...input().signals, workspace_fingerprint: 'workspace-a' } };
    const initial = await runArchetypePostGate(gateInput);
    expect(initial.repair_planned?.source_workspace_fingerprint).toBe('workspace-a');
    expect(writeEvidence).toHaveBeenCalledWith(expect.objectContaining({
      requireCanonicalPersistence: true,
      record: expect.objectContaining({ workspace_fingerprint: 'workspace-a' }),
    }));
    const first = await runArchetypePostGate({
      ...gateInput,
      evidenceRunId: 'evidence-run-2',
      repairRun: appliedRepair(initial.repair_planned!),
    });
    expect(first.repair_planned?.verification_observations?.[0].status).toBe('same_failure_unchanged');
    const secondInput = {
      ...gateInput,
      signals: { ...gateInput.signals, workspace_fingerprint: 'workspace-b' },
      evidenceRunId: 'evidence-run-3',
      repairRun: appliedRepair(first.repair_planned!),
    };
    const second = await runArchetypePostGate(secondInput);
    expect(second.repair_planned?.verification_observations?.[1]).toMatchObject({
      source_evidence_run_id: 'evidence-run-2',
      latest_evidence_run_id: 'evidence-run-3',
      workspace_fingerprint: 'workspace-b',
      applied_attempts: [2],
      status: 'same_failure_after_change',
    });
    expect(second.repair_planned?.actions[0].verification).toContain('new hypothesis');
    expect(second.repair_planned?.actions[0].verification).toContain('targeted check');
    expect(second).toMatchObject({ verification_exhausted: false, healing_applied: undefined });
    await persistJudgeRejection({
      planId: 'plan-1', stepId: 'step-1', postGate: second,
      effectiveSandboxId: 'sandbox-1', infrastructureGeneration: 4,
      executionEventId: 'cycle:step:turn',
    });
    expect(patchPlanStepAtomically).toHaveBeenCalledWith(expect.objectContaining({
      expectedGeneration: 4,
      patch: expect.objectContaining({ metadata: { repair_run: second.repair_planned } }),
    }));
    const replay = await runArchetypePostGate({ ...secondInput, repairRun: second.repair_planned });
    expect(replay.repair_planned).toEqual(second.repair_planned);
    expect(replay.repair_planned).toMatchObject({ attempt_count: 2, max_attempts: 3 });
    expect(replay.repair_planned?.verification_observations).toHaveLength(2);
  });

  it.each(['missing fingerprint', 'reused evidence', 'mixed evidence'])('keeps %s unknown using canonical persistence', async (mode) => {
    recordToolFailure.mockResolvedValue({ ...item, tool_failures: { judge_evidence_collector: 1 } });
    const initial = await runArchetypePostGate({
      ...input(), signals: { ...input().signals, workspace_fingerprint: 'workspace-a' },
    });
    writeEvidence.mockImplementation(async ({ itemId, record }: any) => ({
      ...record, schema_version: 1, item_id: itemId,
      workspace_fingerprint: mode === 'missing fingerprint' ? undefined : 'workspace-a',
      evidence_provenance: mode !== 'missing fingerprint'
        ? { mode: mode === 'reused evidence' ? 'reused' : 'mixed', reused_from_evidence_run_ids: ['evidence-run-1'] } : undefined,
    }));
    const result = await runArchetypePostGate({
      ...input(), evidenceRunId: 'evidence-run-2',
      signals: { ...input().signals, workspace_fingerprint: 'workspace-b' },
      repairRun: appliedRepair(initial.repair_planned!),
    });
    expect(result.repair_planned?.verification_observations?.[0].status).toBe('unknown');
    expect(result.repair_planned?.actions[0].verification).not.toContain('new hypothesis');
  });

  it('persists scenario receipts as structured acceptance observations', async () => {
    recordToolFailure.mockResolvedValue({
      ...item,
      tool_failures: { judge_evidence_collector: 1 },
    });

    await runArchetypePostGate({
      ...input(),
      signals: {
        ...input().signals,
        scenarios: {
          ok: true,
          scenarios: [{
            scenario: 'contact submit',
            pass: true,
            duration_ms: 25,
            steps: [{
              index: 0,
              action: 'submit',
              ok: true,
              receipt: {
                kind: 'http_response',
                pass: true,
                method: 'POST',
                target: '/api/contact',
                actual_status: 201,
                expected_statuses: [201],
              },
            }],
          }],
        },
      },
    });

    expect(writeEvidence).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        scenario_assertions: [
          expect.objectContaining({
            kind: 'http_response',
            target: '/api/contact',
            actual_status: 201,
          }),
        ],
        observations: [
          expect.objectContaining({
            source: 'e2e_scenario',
            target: '/api/contact',
            method: 'POST',
            http_status: 201,
          }),
        ],
      }),
    }));
  });

  it('treats missing canonical evidence persistence as unavailable', async () => {
    writeEvidence.mockRejectedValueOnce(
      new Error('Canonical evidence persistence failed'),
    );

    await expect(runArchetypePostGate(input())).resolves.toMatchObject({
      ran: false,
      error: expect.stringContaining('Canonical evidence persistence failed'),
    });
    expect(runJudge).not.toHaveBeenCalled();
    expect(recordToolFailure).not.toHaveBeenCalled();
  });
});
