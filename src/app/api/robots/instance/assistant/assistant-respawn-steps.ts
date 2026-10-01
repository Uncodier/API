'use step';

import {
  countRecentRespawns,
  spawnSilentContinueWorkflow,
} from '@/lib/services/robot-instance/assistant-respawn';
import type { AssistantRecoveryScope } from '@/lib/services/robot-instance/assistant-recovery';

export async function countRecentRespawnsStep(instanceId: string): Promise<number> {
  'use step';
  return countRecentRespawns(instanceId);
}

export async function spawnSilentContinueStep(params: AssistantRecoveryScope): Promise<boolean> {
  'use step';
  return spawnSilentContinueWorkflow(params);
}

spawnSilentContinueStep.maxRetries = 0;
