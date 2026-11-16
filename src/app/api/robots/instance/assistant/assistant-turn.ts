import { processAssistantTurn as processTurn } from './assistant-turn-core';
import { releaseFailedAssistantTurn } from '@/lib/services/robot-instance/assistant-recovery';
import { getProviderRetryDecision } from '@/lib/services/robot-instance/assistant-failure-policy';
import { readRequirementAssistantHost } from './requirement-host';

/** No automatic replay of a step that can publish, send or mutate state. */
export async function processAssistantTurn(...args: Parameters<typeof processTurn>) {
  'use step';
  try {
    return await processTurn(...args);
  } catch (error) {
    const scope = args[0].recoveryScope;
    const retry = getProviderRetryDecision(error);
    if (scope && !readRequirementAssistantHost(args[0]) && retry) {
      try {
        await releaseFailedAssistantTurn(scope, retry.retryAt);
        // Carry the decision as data: Workflow's FatalError can hide the cause.
        return { recoverableFailure: true, retryNotBefore: retry.retryAt, isDone: false, text: '', messages: args[1] };
      } catch {
        // Missing evidence, uncertain effects, changed ownership: fail closed.
      }
    }
    throw error;
  }
}
processAssistantTurn.maxRetries = 0;