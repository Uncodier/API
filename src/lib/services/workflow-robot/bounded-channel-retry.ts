import { buildWorkflowRetryContext, canRetryStep, interpolateWorkflowText, resolveMaxRetries } from './retry';

type Step = Record<string, any>;

export function channelStepRetryCount(step: Step): number {
  return Number.isInteger(step.retry_count) && step.retry_count > 0 ? step.retry_count : 0;
}

/** A pending step with a recorded failure is resumed only by a separate, newly claimed advance. */
export function recordChannelStepFailure(step: Step, message: string, retryable: boolean): void {
  step.retry_count = channelStepRetryCount(step) + 1;
  step.error_message = message.slice(0, 500);
  const retry = retryable && canRetryStep(step.retry_count, resolveMaxRetries(step.max_retries));
  // Keep the parent non-terminal while retries remain so failure/success branches cannot run early.
  step.status = retry ? 'pending' : 'failed';
  step.completed_at = retry ? null : new Date().toISOString();
}

export function channelStepRetryContext(
  step: Step, triggerPayload: Record<string, unknown>, previousOutputs: Record<string, unknown>,
): string {
  if (!channelStepRetryCount(step)) return '';
  return buildWorkflowRetryContext({
    errorMessage: step.error_message || 'Unknown error', retryCount: channelStepRetryCount(step),
    maxRetries: resolveMaxRetries(step.max_retries), lastOutput: step.actual_output,
    step: { id: step.id, order: step.order, title: step.title },
    triggerSnippet: JSON.stringify(triggerPayload || {}, null, 2),
    recoveryPlan: typeof step.recovery_plan === 'string'
      ? interpolateWorkflowText(step.recovery_plan, { trigger: triggerPayload, steps: previousOutputs }) : '',
  });
}