'use step';

import { insertUserActionLog, markRemoteInstanceError, setUserMessageStatus } from './user-message-log';
import { RecoveryError } from '@/lib/services/robot-instance/assistant-recovery-schema';
import { persistCreditExhaustionNotice } from '@/lib/services/robot-instance/credit-exhaustion';

export async function persistUserMessageStep(
  instanceId: string,
  message: string,
  siteId: string,
  userId?: string | null,
  details?: Record<string, unknown>
): Promise<{ id: string }> {
  'use step';
  return insertUserActionLog({
    instanceId,
    siteId,
    userId,
    message,
    details,
  });
}

export async function markAssistantFailedStep(
  instanceId: string,
  siteId: string,
  userId: string | null | undefined,
  errorMessage: string,
  userMessageLogId?: string | null,
  expectedGeneration?: number,
): Promise<void> {
  'use step';
  await markRemoteInstanceError({
    instanceId,
    siteId,
    userId,
    errorMessage,
    userMessageLogId,
    expectedGeneration,
  });
}

export async function completeUserMessageStep(logId: string, expectedGeneration?: number): Promise<void> {
  'use step';
  const saved = await setUserMessageStatus(logId, 'completed', expectedGeneration);
  if (expectedGeneration !== undefined && !saved) throw new RecoveryError('inactive');
}

export async function pauseUserMessageStep(logId: string, expectedGeneration?: number): Promise<void> {
  'use step';
  const saved = await setUserMessageStatus(logId, 'paused', expectedGeneration);
  if (expectedGeneration !== undefined && !saved) throw new RecoveryError('inactive');
}

export async function pauseAssistantForCreditsStep(
  instanceId: string, siteId: string, userId: string,
  userMessageLogId: string, expectedGeneration: number,
) {
  'use step';
  return persistCreditExhaustionNotice({
    instanceId, siteId, userId, userMessageLogId, expectedGeneration,
    eventId: `${userMessageLogId}:${expectedGeneration}:credits_exhausted`,
  });
}
