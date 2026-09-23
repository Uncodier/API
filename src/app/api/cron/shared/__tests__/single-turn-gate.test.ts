import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunGateForFlow = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockRunArchetypePostGate = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockUpdatePlanStepStatus = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockCompletePlanStepAfterGate = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockSetItemStatus = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockGetBacklogItem = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockMaybeSingle = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockClassifyRequirementType = jest.fn(() => 'task');
const mockComputeFingerprint = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<string | null>
>;

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => {
      const query: any = {
        select: jest.fn(() => query),
        eq: jest.fn(() => query),
        maybeSingle: mockMaybeSingle,
      };
      return query;
    }),
  },
}));

jest.mock('@/lib/services/requirement-backlog', () => ({
  getBacklogItem: mockGetBacklogItem,
  setItemStatus: mockSetItemStatus,
}));

jest.mock('@/lib/services/requirement-flows', () => ({
  classifyRequirementType: mockClassifyRequirementType,
}));

jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: { STEP_STATUS: 'step_status' },
  logCronInfrastructureEvent: jest.fn(),
}));

jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({
  InfrastructureStateDatabaseError: class extends Error {},
  completePlanStepAfterGateAtomically: mockCompletePlanStepAfterGate,
  updatePlanStepStatusAtomically: mockUpdatePlanStepStatus,
}));

jest.mock('@/lib/services/cron-infrastructure-state', () => ({
  buildGateInfrastructureWait: jest.fn(() => ({ kind: 'gate' })),
}));

jest.mock('../commit/pre-push-build-validation', () => ({
  computeApplicationBuildFingerprint: mockComputeFingerprint,
}));

jest.mock('@/lib/services/requirement-ground-truth', () => ({
  writeEvidence: jest.fn(async () => ({})),
}));

jest.mock('@/lib/services/sandbox-sdk', () => ({
  sandboxIdentity: jest.fn(() => 'replacement-sandbox'),
}));

jest.mock('../gate-failure-healing', () => ({
  applyGateFailureHealing: jest.fn(),
}));

jest.mock('../step-archetype-postgate', () => ({
  runArchetypePostGate: mockRunArchetypePostGate,
}));

jest.mock('../gates', () => ({
  runGateForFlow: mockRunGateForFlow,
}));

jest.mock('../single-turn-helpers', () => ({
  buildGateErrorFeedback: jest.fn(() => ({
    excerpt: '',
    raw: '',
    categories: [],
  })),
  getDeclaredProtectedRoutes: jest.fn(() => []),
  getDeclaredValidationTargets: jest.fn(() => []),
  getDeclaredTestCommand: jest.fn(() => undefined),
  isTransientGateFailure: jest.fn(() => false),
}));

import { runSingleTurnGate } from '../single-turn-gate';
import { singleTurnGateInput as input } from './single-turn-gate.fixture';

describe('runSingleTurnGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClassifyRequirementType.mockReturnValue('task');
    mockComputeFingerprint.mockResolvedValue('a'.repeat(64));
    mockRunGateForFlow.mockResolvedValue({ ok: true, richSignals: {} });
    mockGetBacklogItem.mockResolvedValue({
      kind: 'app',
      item: { acceptance: ['PATCH /api/assets/:id returns 200.'] },
    });
    mockMaybeSingle.mockResolvedValue({
      data: { steps: [{ id: 'step-1', status: 'in_progress' }] },
      error: null,
    });
    mockRunArchetypePostGate.mockResolvedValue({
      ran: true,
      judge_verdict: 'approved',
    });
    mockCompletePlanStepAfterGate.mockResolvedValue({
      persisted: true,
      state: 'applied',
      generation: 5,
      final: true,
    });
  });

  it('does not complete the backlog when the final step CAS is stale', async () => {
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockCompletePlanStepAfterGate.mockResolvedValueOnce({
      persisted: false,
      state: 'stale',
      generation: 5,
      final: false,
    });

    await expect(runSingleTurnGate(input())).resolves.toMatchObject({
      ok: false,
      concurrencyHalt: true,
    });
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('marks the backlog done only after the completion CAS succeeds', async () => {
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockSetItemStatus.mockResolvedValue({ id: 'item-1', status: 'done' });

    await expect(runSingleTurnGate(input())).resolves.toMatchObject({
      ok: true,
      isDone: true,
      persistedTerminalStatus: 'completed',
    });
    expect(mockSetItemStatus).toHaveBeenCalledWith({
      requirementId: 'req-1',
      itemId: 'item-1',
      status: 'done',
    });
    expect(
      mockCompletePlanStepAfterGate.mock.invocationCallOrder[0],
    ).toBeLessThan(mockSetItemStatus.mock.invocationCallOrder[0]);
  });

  it.each([
    ['retryable failed', { id: 'step-2', status: 'failed', retry_count: 1 }],
    ['exhausted failed', { id: 'step-2', status: 'failed', retry_count: 2 }],
  ])(
    'does not run the final Judge with a %s sibling',
    async (_label, sibling) => {
      mockMaybeSingle.mockResolvedValue({
        data: {
          steps: [
            { id: 'step-1', status: 'in_progress' },
            sibling,
          ],
        },
        error: null,
      });
      mockUpdatePlanStepStatus.mockResolvedValueOnce({
        persisted: true,
        state: 'applied',
        generation: 4,
      });
      mockCompletePlanStepAfterGate.mockResolvedValueOnce({
        persisted: true,
        state: 'applied',
        generation: 5,
        final: false,
      });

      await expect(runSingleTurnGate(input())).resolves.toMatchObject({
        ok: true,
        persistedTerminalStatus: 'completed',
      });
      expect(mockRunArchetypePostGate).not.toHaveBeenCalled();
      expect(mockSetItemStatus).not.toHaveBeenCalled();
    },
  );

  it('runs the final Judge when all sibling steps are cancelled', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        steps: [
          { id: 'step-1', status: 'in_progress' },
          { id: 'step-2', status: 'cancelled' },
        ],
      },
      error: null,
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockSetItemStatus.mockResolvedValue({ id: 'item-1', status: 'done' });

    await expect(runSingleTurnGate(input())).resolves.toMatchObject({
      ok: true,
      persistedTerminalStatus: 'completed',
    });
    expect(mockRunArchetypePostGate).toHaveBeenCalledTimes(1);
    expect(mockCompletePlanStepAfterGate).toHaveBeenCalledWith(
      expect.objectContaining({ finalGateApproved: true }),
    );
  });

  it('does not run the final Judge when the current step id is duplicated', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        steps: [
          { id: 'step-1', status: 'in_progress' },
          { id: 'step-1', status: 'completed' },
        ],
      },
      error: null,
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockCompletePlanStepAfterGate.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 5,
      final: false,
    });

    await runSingleTurnGate(input());

    expect(mockRunArchetypePostGate).not.toHaveBeenCalled();
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('runs the Judge against explicit step criteria during adjudication', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        steps: [
          { id: 'step-1', status: 'in_progress' },
          { id: 'step-2', status: 'pending' },
        ],
      },
      error: null,
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockCompletePlanStepAfterGate.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 5,
      final: false,
    });

    await runSingleTurnGate({
      ...input(),
      requireContractJudge: true,
      step: {
        ...input().step,
        expected_output: 'GET /orders returns 200',
        success_criteria: ['The orders page renders'],
        validation_rules: ['npm test succeeds'],
      },
    });

    expect(mockRunArchetypePostGate).toHaveBeenCalledWith(
      expect.objectContaining({
        contractAcceptance: expect.arrayContaining([
          'The orders page renders',
          'npm test succeeds',
        ]),
      }),
    );
    const postGateInput = mockRunArchetypePostGate.mock.calls.at(-1)?.[0];
    expect(postGateInput?.contractAcceptance).not.toContain('Do it');
    expect(postGateInput?.contractAcceptance).not.toContain(
      'GET /orders returns 200',
    );
  });

  it('passes assistant tests and API observations to the Judge', async () => {
    mockRunGateForFlow.mockResolvedValue({
      ok: true,
      richSignals: {
        observations: [{
          kind: 'api',
          disposition: 'pass',
          source: 'contract',
          target: 'POST /api/assets',
          detail: 'HTTP 201',
        }],
      },
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });

    await runSingleTurnGate({
      ...input(),
      result: {
        messages: [],
        steps: [{
          toolCalls: [{
            id: 'test',
            toolName: 'sandbox_run_command',
            args: { command: 'npm test' },
          }],
          toolResults: [{
            toolCallId: 'test',
            result: { exitCode: 0, stdout: 'PASS' },
          }],
        }],
      },
    });

    expect(mockRunArchetypePostGate).toHaveBeenCalledWith(
      expect.objectContaining({
        signals: expect.objectContaining({
          tests: expect.objectContaining({
            ok: true,
            tests: [expect.objectContaining({ command: 'npm test' })],
          }),
          observations: [
            expect.objectContaining({ target: 'POST /api/assets' }),
          ],
        }),
      }),
    );
  });

  it('does not complete a step that became final without Judge approval', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        steps: [
          { id: 'step-1', status: 'in_progress' },
          { id: 'step-2', status: 'pending' },
        ],
      },
      error: null,
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockCompletePlanStepAfterGate.mockResolvedValueOnce({
      persisted: false,
      state: 'guarded',
      generation: 4,
      final: true,
    });

    await expect(runSingleTurnGate(input())).resolves.toMatchObject({
      ok: false,
      concurrencyHalt: true,
      error: expect.stringContaining('fresh final Judge'),
    });
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('refuses to complete a final step without a backlog binding', async () => {
    const result = await runSingleTurnGate({
      ...input(),
      backlogItemId: null,
    });

    expect(result).toMatchObject({
      ok: false,
      isDone: true,
      error: expect.stringContaining('backlog_item_id'),
    });
    expect(mockUpdatePlanStepStatus).not.toHaveBeenCalled();
    expect(mockRunArchetypePostGate).not.toHaveBeenCalled();
  });

  it('surfaces post-gate errors instead of claiming remediation', async () => {
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockRunArchetypePostGate.mockResolvedValue({
      ran: false,
      error: 'judge unavailable',
    });

    const result = await runSingleTurnGate(input());
    expect(result).toMatchObject({
      ok: false,
      transient: true,
      error: 'judge unavailable',
      infrastructureGeneration: 4,
    });
    expect(result.remediationScheduled).toBeUndefined();
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('keeps missing origin preconditions non-terminal', async () => {
    mockRunGateForFlow.mockResolvedValueOnce({
      ok: false,
      failureKind: 'missing_precondition',
      signals: [{
        name: 'origin',
        ok: false,
        disposition: 'unknown',
        failureKind: 'missing_precondition',
      }],
      richSignals: {},
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });

    const result = await runSingleTurnGate(input());

    expect(mockUpdatePlanStepStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in_progress' }),
    );
    expect(result).toMatchObject({
      ok: true,
      isDone: true,
      gatePassed: false,
      gateFailureKind: 'missing_precondition',
    });
    expect(result.persistedTerminalStatus).toBeUndefined();
  });

  it('carries a matching cross-turn test receipt into the final Judge', async () => {
    const fingerprint = 'a'.repeat(64);
    mockClassifyRequirementType.mockReturnValue('app');
    mockGetBacklogItem.mockResolvedValueOnce({
      item: {
        acceptance: ['The test suite passes.'],
        evidence: {
          schema_version: 1,
          item_id: 'item-1',
          producer_step_id: 'step-1',
          workspace_fingerprint: fingerprint,
          captured_at: '2026-09-22T12:00:00.000Z',
          critic_passes: 0,
          tests: [{
            command: 'npm test',
            exit_code: 0,
            output_tail: 'PASS',
            ran_after_changes: true,
            captured_at: '2026-09-22T12:00:00.000Z',
            step_id: 'step-1',
            workspace_fingerprint: fingerprint,
          }],
        },
      },
    });
    mockRunGateForFlow.mockResolvedValueOnce({
      ok: true,
      signals: [],
      richSignals: {
        build: { ok: true },
        workspace_fingerprint: fingerprint,
      },
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockSetItemStatus.mockResolvedValue({ id: 'item-1', status: 'done' });

    await runSingleTurnGate(input());

    expect(mockRunArchetypePostGate).toHaveBeenCalledWith(
      expect.objectContaining({
        signals: expect.objectContaining({
          tests: {
            ok: true,
            tests: [expect.objectContaining({
              command: 'npm test',
              workspace_fingerprint: fingerprint,
            })],
          },
        }),
      }),
    );
  });

  it('provides automation gates the context required to persist origin', async () => {
    mockClassifyRequirementType.mockReturnValue('automation');
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockSetItemStatus.mockResolvedValue({ id: 'item-1', status: 'done' });

    await runSingleTurnGate({
      ...input(),
      requirementType: 'automation',
      gitRepoKind: 'automation',
    });

    expect(mockRunGateForFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: 'automation',
        appContext: expect.objectContaining({
          gitRepoKind: 'automation',
          stepContext: expect.objectContaining({ acceptance: ['PATCH /api/assets/:id returns 200.'] }),
        }),
      }),
    );
  });

  it('uses the lightweight app gate for a non-final plan step', async () => {
    mockClassifyRequirementType.mockReturnValue('app');
    mockMaybeSingle.mockResolvedValue({
      data: {
        steps: [
          { id: 'step-1', status: 'in_progress' },
          { id: 'step-2', status: 'pending' },
        ],
      },
      error: null,
    });
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockCompletePlanStepAfterGate.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 5,
      final: false,
    });

    await runSingleTurnGate({
      ...input(),
      plan: {
        ...input().plan,
        steps: [
          { id: 'step-1', status: 'in_progress' },
          { id: 'step-2', status: 'pending' },
        ],
      },
      validateDeployment: false,
    });

    expect(mockRunGateForFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        appContext: expect.objectContaining({
          validationScope: 'intermediate',
          validateDeployment: false,
        }),
      }),
    );
  });

  it('retries with the final gate when a lightweight step becomes final', async () => {
    mockClassifyRequirementType.mockReturnValue('app');
    mockMaybeSingle.mockResolvedValue({
      data: {
        steps: [{ id: 'step-1', status: 'in_progress' }],
      },
      error: null,
    });

    const result = await runSingleTurnGate({
      ...input(),
      plan: {
        ...input().plan,
        steps: [
          { id: 'step-1', status: 'in_progress' },
          { id: 'step-2', status: 'pending' },
        ],
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        concurrencyHalt: true,
        error: expect.stringContaining('full final gate'),
      }),
    );
    expect(mockRunArchetypePostGate).not.toHaveBeenCalled();
    expect(mockCompletePlanStepAfterGate).not.toHaveBeenCalled();
  });

  it('reports backlog completion failures with the committed generation', async () => {
    mockUpdatePlanStepStatus.mockResolvedValueOnce({
      persisted: true,
      state: 'applied',
      generation: 4,
    });
    mockSetItemStatus.mockRejectedValue(new Error('backlog unavailable'));

    await expect(runSingleTurnGate(input())).resolves.toMatchObject({
      ok: false,
      transient: true,
      infrastructureGeneration: 5,
      error: expect.stringContaining('backlog unavailable'),
    });
  });
});
