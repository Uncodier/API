import { executeScheduledWorkflowStep } from './steps';

/** Durable dispatch replaces an unregistered serverless background promise. */
export async function executeScheduledWorkflow(runPlanId: string) {
  'use workflow';
  return await executeScheduledWorkflowStep(runPlanId);
}