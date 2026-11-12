'use step';

import {
  initializeAssistantRecovery, loadAssistantRecovery, assertAssistantRecoveryActive,
  markAssistantRecoveryInFlight, checkpointAssistantRecovery,
  type AssistantRecoveryScope, type AssistantRecoveryExecution,
} from '@/lib/services/robot-instance/assistant-recovery';
import { withAssistantRouting } from './execution-routing';

export async function prepareRecoveryStep(
  scope: AssistantRecoveryScope, execution: AssistantRecoveryExecution, resumeToken?: string,
) {
  'use step';
  try {
    if (resumeToken) {
      const snapshot = await loadAssistantRecovery(scope, resumeToken);
      return await withAssistantRouting(scope.siteId, snapshot.execution.executionRouting,
        async () => ({ ok: true as const, snapshot }));
    }
    await withAssistantRouting(scope.siteId, execution.executionRouting,
      () => initializeAssistantRecovery(scope, execution));
    return { ok: true as const, snapshot: undefined };
  } catch {
    return { ok: false as const };
  }
}

export async function guardRecoveryStep(
  scope: AssistantRecoveryScope, startTurn = false, messages?: unknown[], kind: 'turn' | 'plan' = 'turn',
): Promise<boolean> {
  'use step';
  try {
    if (startTurn) await markAssistantRecoveryInFlight(scope, messages, kind);
    else await assertAssistantRecoveryActive(scope);
    return true;
  } catch { return false; }
}

export async function checkpointRecoveryStep(
  scope: AssistantRecoveryScope, messages: unknown[], continuation?: { responseNodeIds: string[] },
): Promise<boolean> {
  'use step';
  try {
    await checkpointAssistantRecovery(scope, { messages, continuation });
    return true;
  } catch { return false; }
}

// Retrying these read-modify-write steps could consume another generation's claim.
prepareRecoveryStep.maxRetries = 0;
guardRecoveryStep.maxRetries = 0;
checkpointRecoveryStep.maxRetries = 0;