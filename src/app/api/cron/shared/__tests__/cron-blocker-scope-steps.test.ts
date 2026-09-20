const blockBacklogItemForCircuitAtomically = jest.fn();
const blockRequirementForInfrastructureCircuit = jest.fn();
const blockRequirementForProductNoProgress = jest.fn();

jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({
  blockBacklogItemForCircuitAtomically,
  blockRequirementForInfrastructureCircuit,
  blockRequirementForProductNoProgress,
}));

import {
  scopeInfrastructureCircuitStep,
  scopeProductNoProgressCircuitStep,
} from '../cron-blocker-scope-steps';

const base = {
  requirementId: 'req-1',
  siteId: 'site-1',
  instanceId: 'instance-1',
  planId: 'plan-1',
  stepId: 'step-1',
  backlogItemId: 'item-1',
  message: 'Circuit exhausted.',
  expectedExecutionGeneration: 2,
  attemptLimits: { core: 4, ornamental: 2 },
};

describe('scope-aware requirement circuits', () => {
  beforeEach(() => jest.clearAllMocks());

  it('isolates infrastructure failure when independent work remains', async () => {
    blockBacklogItemForCircuitAtomically.mockResolvedValue({
      state: 'applied',
      isolated: true,
      affected_item_ids: ['item-1', 'dependent-1'],
    });

    await expect(scopeInfrastructureCircuitStep({
      ...base,
      expectedGeneration: 3,
      provenance: 'cron_infrastructure',
      eventId: 'event-1',
    })).resolves.toEqual({
      itemIsolated: true,
      requirementBlocked: false,
      affectedItemIds: ['item-1', 'dependent-1'],
    });
    expect(blockRequirementForInfrastructureCircuit).not.toHaveBeenCalled();
  });

  it('blocks globally only when infrastructure leaves no alternative', async () => {
    blockBacklogItemForCircuitAtomically.mockResolvedValue({
      state: 'no_alternative',
      isolated: false,
      affected_item_ids: ['item-1'],
    });
    blockRequirementForInfrastructureCircuit.mockResolvedValue({
      blocked: true,
      state: 'applied',
    });

    const result = await scopeInfrastructureCircuitStep({
      ...base,
      expectedGeneration: 3,
      provenance: 'cron_infrastructure',
      eventId: 'event-1',
    });

    expect(result).toMatchObject({
      itemIsolated: false,
      requirementBlocked: true,
    });
    expect(blockRequirementForInfrastructureCircuit).toHaveBeenCalled();
  });

  it('falls back to the guarded global RPC before the scoped migration lands', async () => {
    blockBacklogItemForCircuitAtomically.mockResolvedValue({
      state: 'unsupported',
      isolated: false,
      affected_item_ids: [],
    });
    blockRequirementForInfrastructureCircuit.mockResolvedValue({
      blocked: true,
      state: 'applied',
    });

    await expect(scopeInfrastructureCircuitStep({
      ...base,
      expectedGeneration: 3,
      provenance: 'cron_infrastructure',
      eventId: 'event-legacy',
    })).resolves.toMatchObject({
      itemIsolated: false,
      requirementBlocked: true,
    });
  });

  it.each([
    ['infrastructure', scopeInfrastructureCircuitStep],
    ['product no-progress', scopeProductNoProgressCircuitStep],
  ])(
    'does not escalate a stale %s scope mismatch to the requirement',
    async (_kind, scopeCircuit) => {
      blockBacklogItemForCircuitAtomically.mockResolvedValue({
        state: 'stale',
        isolated: false,
        affected_item_ids: [],
      });

      const circuitParams = scopeCircuit === scopeInfrastructureCircuitStep
        ? {
            ...base,
            expectedGeneration: 3,
            provenance: 'cron_infrastructure',
            eventId: 'event-stale',
          }
        : {
            ...base,
            expectedStepGeneration: 3,
            cycleId: 'cycle-stale',
            minimumFailures: 3,
          };
      await expect(scopeCircuit(circuitParams as never)).resolves.toEqual({
        itemIsolated: false,
        requirementBlocked: false,
        affectedItemIds: [],
      });
      expect(blockRequirementForInfrastructureCircuit).not.toHaveBeenCalled();
      expect(blockRequirementForProductNoProgress).not.toHaveBeenCalled();
    },
  );

  it('uses the same frontier policy for product no-progress', async () => {
    blockBacklogItemForCircuitAtomically.mockResolvedValue({
      state: 'applied',
      isolated: true,
      affected_item_ids: ['item-1'],
    });

    const result = await scopeProductNoProgressCircuitStep({
      ...base,
      expectedStepGeneration: 1,
      cycleId: 'cycle-1',
      minimumFailures: 3,
    });

    expect(result.itemIsolated).toBe(true);
    expect(blockRequirementForProductNoProgress).not.toHaveBeenCalled();
    expect(blockBacklogItemForCircuitAtomically).toHaveBeenCalledWith(expect.objectContaining({
      category: 'product_defect',
      resolutionActor: 'executor',
      attemptLimits: { core: 4, ornamental: 2 },
    }));
  });
});
