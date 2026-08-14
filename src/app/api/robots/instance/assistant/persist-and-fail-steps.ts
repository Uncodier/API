'use step';

import { insertUserActionLog, markRemoteInstanceError } from './user-message-log';

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
  errorMessage: string
): Promise<void> {
  'use step';
  await markRemoteInstanceError({
    instanceId,
    siteId,
    userId,
    errorMessage,
  });
}
