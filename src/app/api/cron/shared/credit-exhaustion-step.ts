'use step';

import { CreditService } from '@/lib/services/billing/CreditService';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import { persistCreditExhaustionNotice } from '@/lib/services/robot-instance/credit-exhaustion';
import { assertCronExecutionOwnership, type CronExecutionOwnership } from './cron-execution-ownership';

/** Billing outages are failures, not evidence of insufficient credits. */
export async function checkCycleCreditsStep(siteId: string): Promise<boolean> {
  'use step';
  try {
    await CreditService.requireCredits(siteId, 0.001);
    return true;
  } catch (error) {
    if (isInsufficientCreditsError(error)) return false;
    throw error;
  }
}

export async function emitCreditExhaustionStep(params: {
  instanceId: string;
  siteId: string;
  userId?: string | null;
  cycleId: string;
  ownership: CronExecutionOwnership;
  planId?: string;
  stepId?: string;
}) {
  'use step';
  await assertCronExecutionOwnership({ ...params.ownership, allowTerminal: true });
  return persistCreditExhaustionNotice({
    instanceId: params.instanceId,
    siteId: params.siteId,
    userId: params.userId,
    eventId: `${params.cycleId}:credits_exhausted`,
    requirementId: params.ownership.requirementId,
    planId: params.planId,
    stepId: params.stepId,
    beforeWrite: () => assertCronExecutionOwnership({ ...params.ownership, allowTerminal: true }),
  });
}