'use step';

import {
  countRecentRespawns,
  spawnSilentContinueWorkflow,
} from '@/lib/services/robot-instance/assistant-respawn';

export async function countRecentRespawnsStep(instanceId: string): Promise<number> {
  'use step';
  return countRecentRespawns(instanceId);
}

export async function spawnSilentContinueStep(params: {
  instanceId: string;
  siteId: string;
  userId: string;
  customTools?: any[];
  useSdkTools?: boolean;
  systemPrompt?: string;
  agentType?: string;
  userPhone?: string;
  instanceNodeId?: string;
  expectedResultsAmount?: number;
  contextString?: string;
}): Promise<void> {
  'use step';
  await spawnSilentContinueWorkflow(params);
}
