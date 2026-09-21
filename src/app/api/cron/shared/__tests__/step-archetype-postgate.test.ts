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

    await expect(runArchetypePostGate(input())).resolves.toMatchObject({
      ran: true,
      judge_verdict: 'rejected',
      judge_failure_kind: 'evidence_gap',
      healing_applied: 'collect_evidence',
      verification_exhausted: false,
      repair_feedback: expect.stringContaining('Footer links resolve'),
    });
    expect(markNeedsReview).not.toHaveBeenCalled();
    expect(recordToolFailure).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'judge_evidence_collector',
    }));
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
      healing_applied: 'mark_needs_review',
      verification_exhausted: true,
      terminal_step_status: 'cancelled',
    });
    expect(markNeedsReview).toHaveBeenCalledWith(expect.objectContaining({
      requirementId: 'requirement-1',
      itemId: 'item-1',
      reason: expect.stringContaining('verification exhausted after 3 attempts'),
    }));
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
    });
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
