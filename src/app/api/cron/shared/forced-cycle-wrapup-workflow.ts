'use workflow';

import {
  emitCycleWrapUpStep,
  type CycleWrapUpParams,
} from './cycle-wrapup-step';

export type ForcedCycleWrapUpWorkflowInput = Omit<
  CycleWrapUpParams,
  'forceWrapUp' | 'digest'
>;

/**
 * Starts a durable wrap-up when the cron route stops work before the main
 * requirement workflow can run, such as after its circuit breaker opens.
 */
export async function runForcedCycleWrapUpWorkflow(
  input: ForcedCycleWrapUpWorkflowInput,
) {
  'use workflow';

  return emitCycleWrapUpStep({
    ...input,
    digest: null,
    forceWrapUp: true,
  });
}
