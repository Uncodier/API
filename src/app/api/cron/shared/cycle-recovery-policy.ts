import type { CronCycleOutcome } from '@/lib/services/requirement-metadata-patch';
import { boundedFailureDetail } from './cron-ownership-rejection';

export function cycleFailureReason(
  outcome: CronCycleOutcome,
  primaryReason: string | null,
  error: unknown,
): string {
  if (primaryReason && (
    outcome === 'product_failure' || outcome === 'product_no_progress' ||
    outcome === 'infrastructure_exhausted' || outcome === 'paused'
  )) return primaryReason;
  return `The work cycle stopped because of an error: ${boundedFailureDetail(error)}`;
}

/** Execution policy, not prose, decides whether a cycle requires intervention. */
export type CycleRecoveryDisposition =
  | 'retry'
  | 'blocked'
  | 'product_failure'
  | 'delivery_failure';

export function recoveryAfterUnhandledError(outcome: CronCycleOutcome): {
  outcome: CronCycleOutcome;
  disposition: CycleRecoveryDisposition;
} {
  if (outcome === 'product_failure' || outcome === 'product_no_progress') {
    return { outcome, disposition: 'product_failure' };
  }
  if (outcome === 'infrastructure_exhausted' || outcome === 'paused') {
    return { outcome, disposition: 'blocked' };
  }
  // Earlier progress does not turn a later infrastructure failure into success.
  // The durable infrastructure circuit, not the wrap-up agent, exhausts retries.
  return { outcome: 'infrastructure_retry', disposition: 'retry' };
}