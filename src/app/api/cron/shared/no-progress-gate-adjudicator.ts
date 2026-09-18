import type { SingleTurnResult } from './single-turn-types';
import { runSingleTurnGate } from './single-turn-gate';
import { markNoProgressAdjudicationConsumed } from './single-turn-step-state';

type GateInput = Parameters<typeof runSingleTurnGate>[0];

export async function runGateOnlyNoProgressAdjudication(params: {
  gateInput: GateInput;
  executionEventId: string;
}): Promise<SingleTurnResult> {
  const { gateInput, executionEventId } = params;
  console.warn(
    `[SingleTurn] Running gate-only no-progress adjudication for step ${gateInput.step.order}.`,
  );
  const result = await runSingleTurnGate({
    ...gateInput,
    requireContractJudge: true,
    result: { messages: [], steps: [], isDone: true },
  });
  if (result.transient || result.concurrencyHalt) return result;

  const mutation = await markNoProgressAdjudicationConsumed({
    planId: gateInput.plan.id,
    stepId: gateInput.step.id,
    expectedGeneration:
      result.infrastructureGeneration ?? gateInput.infrastructureGeneration,
    eventId: `${executionEventId}:no-progress-consumed`,
    persistedMetadata: gateInput.persistedStep.metadata,
  });
  if (!mutation.persisted && !result.persistedTerminalStatus) {
    return {
      ok: false,
      isDone: false,
      error:
        `No-progress adjudication state changed concurrently (${mutation.state})`,
      effectiveSandboxId: result.effectiveSandboxId,
      infrastructureGeneration: mutation.generation,
      concurrencyHalt: true,
    };
  }
  return {
    ...result,
    infrastructureGeneration:
      mutation.generation ?? result.infrastructureGeneration,
  };
}
