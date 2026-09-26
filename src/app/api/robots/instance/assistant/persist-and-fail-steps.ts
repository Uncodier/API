'use step';

import { insertUserActionLog, markRemoteInstanceError, setUserMessageStatus } from './user-message-log';

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
): Promise<void> {
  'use step';
  await markRemoteInstanceError({
    instanceId,
    siteId,
    userId,
    errorMessage,
    userMessageLogId,
  });
}

export async function completeUserMessageStep(logId: string): Promise<void> {
  'use step';
  await setUserMessageStatus(logId, 'completed');
}

export async function pauseUserMessageStep(logId: string): Promise<void> {
  'use step';
  await setUserMessageStatus(logId, 'paused');
}
