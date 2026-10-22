import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';

export async function executeScheduledWorkflowStep(runPlanId: string) {
  'use step';
  // The ordinary runner owns its durable claim and per-step retry decisions.
  // Never replay an entire run automatically after uncertain paid/tool effects.
  return await runWorkflowPlan(runPlanId);
}
executeScheduledWorkflowStep.maxRetries = 0;