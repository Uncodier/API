import {
  blockBacklogItemForCircuitAtomically,
  blockRequirementForInfrastructureCircuit,
  blockRequirementForProductNoProgress,
  type InfrastructureBlockMutation,
} from '@/lib/services/instance-plan-infrastructure-state';

export type ScopedCircuitResult = {
  itemIsolated: boolean;
  requirementBlocked: boolean;
  affectedItemIds: string[];
  mutation?: InfrastructureBlockMutation;
};

export async function scopeInfrastructureCircuitStep(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  planId: string;
  stepId: string;
  backlogItemId?: string;
  expectedGeneration: number;
  provenance: string;
  message: string;
  eventId: string;
  expectedExecutionGeneration: number;
  retryAfter?: string;
  attemptLimits: { core: number; ornamental: number };
}): Promise<ScopedCircuitResult> {
  'use step';
  const blocker = {
    requirementId: params.requirementId,
    backlogItemId: params.backlogItemId,
    blockerId: `infrastructure:${params.stepId}`,
    category: 'infrastructure_unavailable' as const,
    reason: params.message,
    resolutionActor: 'platform' as const,
    stepId: params.stepId,
    retryAfter:
      params.retryAfter ||
      new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  const isolated = params.backlogItemId
    ? await blockBacklogItemForCircuitAtomically({
        requirementId: params.requirementId,
        siteId: params.siteId,
        instanceId: params.instanceId,
        planId: params.planId,
        stepId: params.stepId,
        backlogItemId: params.backlogItemId,
        expectedStepGeneration: params.expectedGeneration,
        expectedExecutionGeneration: params.expectedExecutionGeneration,
        circuitKind: 'infrastructure',
        blockerId: blocker.blockerId,
        category: blocker.category,
        reason: blocker.reason,
        resolutionActor: blocker.resolutionActor,
        retryAfter: blocker.retryAfter,
        provenance: params.provenance,
        attemptLimits: params.attemptLimits,
      })
    : null;
  if (isolated?.isolated) {
    return {
      itemIsolated: true,
      requirementBlocked: false,
      affectedItemIds: isolated.affected_item_ids,
    };
  }
  if (
    isolated &&
    isolated.state !== 'no_alternative' &&
    isolated.state !== 'unsupported'
  ) {
    return {
      itemIsolated: false,
      requirementBlocked: false,
      affectedItemIds: isolated.affected_item_ids,
    };
  }

  const mutation = await blockRequirementForInfrastructureCircuit(params);
  return {
    itemIsolated: false,
    requirementBlocked: mutation.blocked,
    affectedItemIds: [],
    mutation,
  };
}

export async function scopeProductNoProgressCircuitStep(params: {
  requirementId: string;
  siteId: string;
  instanceId: string;
  planId: string;
  stepId: string;
  backlogItemId?: string;
  expectedStepGeneration: number;
  cycleId: string;
  minimumFailures: number;
  message: string;
  expectedExecutionGeneration: number;
  attemptLimits: { core: number; ornamental: number };
}): Promise<ScopedCircuitResult> {
  'use step';
  const blocker = {
    requirementId: params.requirementId,
    backlogItemId: params.backlogItemId,
    blockerId: `product-no-progress:${params.stepId}`,
    category: 'product_defect' as const,
    reason: params.message,
    resolutionActor: 'executor' as const,
    stepId: params.stepId,
    retryAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  const isolated = params.backlogItemId
    ? await blockBacklogItemForCircuitAtomically({
        requirementId: params.requirementId,
        siteId: params.siteId,
        instanceId: params.instanceId,
        planId: params.planId,
        stepId: params.stepId,
        backlogItemId: params.backlogItemId,
        expectedStepGeneration: params.expectedStepGeneration,
        expectedExecutionGeneration: params.expectedExecutionGeneration,
        circuitKind: 'product_no_progress',
        blockerId: blocker.blockerId,
        category: blocker.category,
        reason: blocker.reason,
        resolutionActor: blocker.resolutionActor,
        retryAfter: blocker.retryAfter,
        cycleId: params.cycleId,
        minimumFailures: params.minimumFailures,
        attemptLimits: params.attemptLimits,
      })
    : null;
  if (isolated?.isolated) {
    return {
      itemIsolated: true,
      requirementBlocked: false,
      affectedItemIds: isolated.affected_item_ids,
    };
  }
  if (
    isolated &&
    isolated.state !== 'no_alternative' &&
    isolated.state !== 'unsupported'
  ) {
    return {
      itemIsolated: false,
      requirementBlocked: false,
      affectedItemIds: isolated.affected_item_ids,
    };
  }

  const mutation = await blockRequirementForProductNoProgress(params);
  return {
    itemIsolated: false,
    requirementBlocked: mutation.blocked,
    affectedItemIds: [],
    mutation,
  };
}
