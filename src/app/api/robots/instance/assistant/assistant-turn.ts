import { processAssistantTurn as processTurn } from './assistant-turn-core';
import { releaseFailedAssistantTurn } from '@/lib/services/robot-instance/assistant-recovery';
import { RecoveryError } from '@/lib/services/robot-instance/assistant-recovery-schema';
import { settledTurnRetry } from './assistant-turn-retry';
import { readRequirementAssistantHost } from './requirement-host';

/** No automatic replay of a step that can publish, send or mutate state. */
export async function processAssistantTurn(...args: Parameters<typeof processTurn>) {
  'use step';
  try {
    return await processTurn(...args);
  } catch (error) {
    const scope = args[0].recoveryScope;
    const requirementHost = readRequirementAssistantHost(args[0]);
    if (scope && !requirementHost && error instanceof RecoveryError) {
      // Workflow reconstructs thrown step failures as FatalError. Preserve this
      // control decision as data without releasing the turn or losing evidence.
      return { recoveryUnavailable: true, recoveryCode: error.code, isDone: false, text: '' };
    }
    // A resumed workflow does not inherit owner connector admission.
    const retry = scope && !requirementHost && !args[0].catalogUserSession && !args[0].connectorIdHint
      ? settledTurnRetry(error, scope.generation ?? 0) : undefined;
    if (scope && retry) {
      try {
        await releaseFailedAssistantTurn(scope, retry.retryAt);
        // Carry the decision as data: Workflow's FatalError can hide the cause.
        return { recoverableFailure: true, retryNotBefore: retry.retryAt, isDone: false, text: '' };
      } catch {
        // Missing evidence, uncertain effects, changed ownership: fail closed.
      }
    }
    throw error;
  }
}
processAssistantTurn.maxRetries = 0;