import type { ScheduledConnectorJob } from './connector-admission';
import { executeScheduledConnectorStep } from './connector-step';

export async function executeScheduledConnectorWorkflow(job: ScheduledConnectorJob) {
  'use workflow';
  // No provider payload, account references or private result in workflow history.
  return await executeScheduledConnectorStep(job);
}
