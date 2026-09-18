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
const mockMaybeSingle = jest.fn() as jest.MockedFunction<
  (...args: any[]) => Promise<any>
>;
const mockClassifyRequirementType = jest.fn(() => 'task');

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
  isTransientGateFailure: jest.fn(() => false),
}));

import { runSingleTurnGate } from '../single-turn-gate';

function input() {
  return {
    sandbox: {} as any,
    effectiveSandboxId: 'sandbox-1',
    plan: { id: 'plan-1', title: 'Plan' },
    step: { id: 'step-1', order: 1, title: 'Step', instructions: 'Do it' },
    persistedStep: { id: 'step-1' },
    requirementId: 'req-1',
    instanceId: 'instance-1',
    siteId: 'site-1',
    requirementType: 'task',
    gitRepoKind: 'applications' as const,
    backlogItemId: 'item-1',
    interactionBaselineSha: 'abc123',
    systemPrompt: 'prompt',
    result: { messages: [] },
    fullTools: {},
    audit: {
      requirementId: 'req-1',
      instanceId: 'instance-1',
      siteId: 'site-1',
    },
    infrastructureGeneration: 3,
  };
}

describe('runSingleTurnGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClassifyRequirementType.mockReturnValue('task');
    mockRunGateForFlow.mockResolvedValue({ ok: true, richSignals: {} });
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
    ['cancelled', { id: 'step-2', status: 'cancelled' }],
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

  it('runs the Judge against the full step contract during adjudication', async () => {
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
          'Do it',
          'GET /orders returns 200',
          'The orders page renders',
          'npm test succeeds',
        ]),
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
        }),
      }),
    );
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
