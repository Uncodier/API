const markNoProgressAdjudicationConsumed = jest.fn();
const markNoProgressAdjudicationRetryable = jest.fn();
const runSingleTurnGate = jest.fn();

jest.mock('../single-turn-step-state', () => ({
  markNoProgressAdjudicationConsumed,
  markNoProgressAdjudicationRetryable,
}));
jest.mock('../single-turn-gate', () => ({
  runSingleTurnGate,
}));

import { runGateOnlyNoProgressAdjudication } from '../no-progress-gate-adjudicator';

function gateInput() {
  return {
    sandbox: {},
    effectiveSandboxId: 'sandbox-1',
    plan: { id: 'plan-1' },
    step: { id: 'step-1', order: 1 },
    persistedStep: {
      id: 'step-1',
      metadata: {
        backlog_item_id: 'item-1',
        no_progress_adjudication: { state: 'requested' },
      },
    },
    requirementId: 'requirement-1',
    instanceId: 'instance-1',
    siteId: 'site-1',
    requirementType: 'develop',
    gitRepoKind: 'applications',
    backlogItemId: 'item-1',
    systemPrompt: 'prompt',
    result: {},
    fullTools: [],
    audit: {},
    infrastructureGeneration: 3,
  } as any;
}

describe('gate-only no-progress adjudicator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('consumes the request only after the contract-aware gate finishes', async () => {
    markNoProgressAdjudicationConsumed.mockResolvedValue({
      persisted: true,
      state: 'applied',
      generation: 6,
    });
    runSingleTurnGate.mockResolvedValue({
      ok: true,
      isDone: true,
      gatePassed: true,
      persistedTerminalStatus: 'completed',
      infrastructureGeneration: 5,
    });

    await runGateOnlyNoProgressAdjudication({
      gateInput: gateInput(),
      executionEventId: 'cycle-3:step-1',
    });

    expect(runSingleTurnGate).toHaveBeenCalledWith(
      expect.objectContaining({
        infrastructureGeneration: 3,
        requireContractJudge: true,
        result: { messages: [], steps: [], isDone: true },
      }),
    );
    expect(markNoProgressAdjudicationConsumed).toHaveBeenCalledWith(
      expect.objectContaining({ expectedGeneration: 5 }),
    );
    expect(runSingleTurnGate.mock.invocationCallOrder[0]).toBeLessThan(
      markNoProgressAdjudicationConsumed.mock.invocationCallOrder[0],
    );
  });

  it('halts when the post-gate retryable CAS is stale', async () => {
    runSingleTurnGate.mockResolvedValue({
      ok: true,
      isDone: false,
      gatePassed: false,
      remediationScheduled: true,
      infrastructureGeneration: 4,
    });
    markNoProgressAdjudicationRetryable.mockResolvedValue({
      persisted: false,
      state: 'stale',
      generation: 5,
    });

    await expect(runGateOnlyNoProgressAdjudication({
      gateInput: gateInput(),
      executionEventId: 'cycle-3:step-1',
    })).resolves.toMatchObject({
      ok: false,
      concurrencyHalt: true,
      infrastructureGeneration: 5,
    });
    expect(runSingleTurnGate).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed product gate retryable for remediation', async () => {
    runSingleTurnGate.mockResolvedValue({
      ok: true,
      isDone: false,
      gatePassed: false,
      remediationScheduled: true,
      infrastructureGeneration: 4,
    });
    markNoProgressAdjudicationRetryable.mockResolvedValue({
      persisted: true,
      state: 'applied',
      generation: 5,
    });

    await runGateOnlyNoProgressAdjudication({
      gateInput: gateInput(),
      executionEventId: 'cycle-3:step-1',
    });

    expect(markNoProgressAdjudicationConsumed).not.toHaveBeenCalled();
    expect(markNoProgressAdjudicationRetryable).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 4,
        eventId: 'cycle-3:step-1:no-progress-retryable',
      }),
    );
  });

  it('keeps the request retryable after a transient gate failure', async () => {
    runSingleTurnGate.mockResolvedValue({
      ok: false,
      isDone: false,
      transient: true,
      infrastructureGeneration: 4,
    });

    await runGateOnlyNoProgressAdjudication({
      gateInput: gateInput(),
      executionEventId: 'cycle-3:step-1',
    });

    expect(markNoProgressAdjudicationConsumed).not.toHaveBeenCalled();
    expect(markNoProgressAdjudicationRetryable).not.toHaveBeenCalled();
  });
});
