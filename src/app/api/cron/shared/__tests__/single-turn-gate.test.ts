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
  });

  it('does not complete the backlog when the final step CAS is stale', async () => {
    mockUpdatePlanStepStatus
      .mockResolvedValueOnce({ persisted: true, state: 'applied', generation: 4 })
      .mockResolvedValueOnce({ persisted: false, state: 'stale', generation: 5 });

    await expect(runSingleTurnGate(input())).resolves.toMatchObject({
      ok: false,
      concurrencyHalt: true,
    });
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('marks the backlog done only after the completion CAS succeeds', async () => {
    mockUpdatePlanStepStatus
      .mockResolvedValueOnce({ persisted: true, state: 'applied', generation: 4 })
      .mockResolvedValueOnce({ persisted: true, state: 'applied', generation: 5 });
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
      mockUpdatePlanStepStatus.mock.invocationCallOrder[1],
    ).toBeLessThan(mockSetItemStatus.mock.invocationCallOrder[0]);
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
    mockUpdatePlanStepStatus
      .mockResolvedValueOnce({ persisted: true, state: 'applied', generation: 4 })
      .mockResolvedValueOnce({ persisted: true, state: 'applied', generation: 5 });
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
    mockUpdatePlanStepStatus
      .mockResolvedValueOnce({ persisted: true, state: 'applied', generation: 4 })
      .mockResolvedValueOnce({ persisted: true, state: 'applied', generation: 5 });
    mockSetItemStatus.mockRejectedValue(new Error('backlog unavailable'));

    await expect(runSingleTurnGate(input())).resolves.toMatchObject({
      ok: false,
      transient: true,
      infrastructureGeneration: 5,
      error: expect.stringContaining('backlog unavailable'),
    });
  });
});
