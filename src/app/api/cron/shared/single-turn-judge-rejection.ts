import {
  patchPlanStepAtomically,
} from '@/lib/services/instance-plan-infrastructure-state';
import type { FlowGateFailureKind } from './gates/types';
import type {
  RunArchetypePostGateResult,
} from './step-archetype-postgate';
import type { SingleTurnResult } from './single-turn-types';
import type { JudgeRepairRun } from './judge-repair-controller';

function repairRunToPersist(params: {
  proposed?: JudgeRepairRun;
  persistedMetadata?: Record<string, unknown>;
}): JudgeRepairRun | undefined {
  const existing = params.persistedMetadata?.repair_run as
    | JudgeRepairRun
    | undefined;
  if (
    existing &&
    (existing.status === 'planned' || existing.status === 'in_progress') &&
    params.proposed?.repair_run_id !== existing.repair_run_id
  ) {
    return existing;
  }
  return params.proposed || existing;
}

export async function persistJudgeRejection(params: {
  planId: string;
  stepId: string;
  postGate: RunArchetypePostGateResult;
  effectiveSandboxId: string;
  infrastructureGeneration: number;
  executionEventId: string;
  persistedStepMetadata?: Record<string, unknown>;
  sleepRequested?: number;
  backgroundTask?: SingleTurnResult['backgroundTask'];
}): Promise<SingleTurnResult> {
  const feedback =
    params.postGate.repair_feedback ||
    `Post-gate Judge returned ${params.postGate.judge_verdict || 'rejected'}.`;
  const failureKind =
    (params.postGate.judge_failure_kind ||
      'product_defect') as FlowGateFailureKind;
  const repairRun = repairRunToPersist({
    proposed: params.postGate.repair_planned,
    persistedMetadata: params.persistedStepMetadata,
  });

  if (params.postGate.verification_exhausted) {
    if (params.postGate.terminal_step_status !== 'cancelled') {
      return {
        ok: false,
        isDone: false,
        error: 'Judge exhaustion did not confirm linked-step cancellation',
        effectiveSandboxId: params.effectiveSandboxId,
        infrastructureGeneration: params.infrastructureGeneration,
        concurrencyHalt: true,
        judgeAdjudicated: true,
      };
    }
    // markNeedsReview already cancels linked work. Re-applying the same
    // terminal status is allowed by the atomic RPC and also covers a missing
    // linkage without attempting the invalid cancelled -> failed transition.
    const terminalMutation = await patchPlanStepAtomically({
      planId: params.planId,
      stepId: params.stepId,
      expectedGeneration: params.infrastructureGeneration,
      eventId: `${params.executionEventId}:judge-exhausted`,
      patch: {
        status: 'cancelled',
        error_message: feedback,
        completed_at: new Date().toISOString(),
        ...(repairRun
          ? {
              metadata: {
                ...(params.persistedStepMetadata || {}),
                repair_run: repairRun,
              },
            }
          : {}),
      },
    });
    if (!terminalMutation.persisted) {
      return {
        ok: false,
        isDone: false,
        error:
          `Judge exhaustion persistence rejected (${terminalMutation.state})`,
        effectiveSandboxId: params.effectiveSandboxId,
        infrastructureGeneration: terminalMutation.generation,
        concurrencyHalt: true,
        judgeAdjudicated: true,
      };
    }
    return {
      ok: true,
      isDone: true,
      effectiveSandboxId: params.effectiveSandboxId,
      gatePassed: false,
      gateErrorExcerpt: feedback,
      persistedTerminalStatus: 'cancelled',
      gateFailureKind: failureKind,
      infrastructureGeneration:
        terminalMutation.generation ?? params.infrastructureGeneration,
      judgeAdjudicated: true,
    };
  }

  const mutation = await patchPlanStepAtomically({
    planId: params.planId,
    stepId: params.stepId,
    expectedGeneration: params.infrastructureGeneration,
    eventId: `${params.executionEventId}:judge-feedback`,
    patch: {
      status: 'in_progress',
      error_message: feedback,
      ...(repairRun
        ? {
            metadata: {
              ...(params.persistedStepMetadata || {}),
              repair_run: repairRun,
            },
          }
        : {}),
    },
  });
  if (!mutation.persisted) {
    return {
      ok: false,
      isDone: false,
      error: `Judge feedback persistence rejected (${mutation.state})`,
      effectiveSandboxId: params.effectiveSandboxId,
      infrastructureGeneration: mutation.generation,
      concurrencyHalt: true,
    };
  }

  return {
    ok: true,
    isDone: false,
    effectiveSandboxId: params.effectiveSandboxId,
    gatePassed: false,
    gateErrorExcerpt: feedback,
    sleepRequested: params.sleepRequested,
    backgroundTask: params.backgroundTask,
    gateFailureKind: failureKind,
    judgeAdjudicated: true,
    infrastructureGeneration:
      mutation.generation ?? params.infrastructureGeneration,
  };
}
