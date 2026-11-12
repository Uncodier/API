import { buildMaintenancePromptForFlow, type MaintenancePromptInput } from './prompt';

/** The prompt's backlog service dependency stays outside deterministic workflow code. */
export async function buildMaintenancePromptStep(input: MaintenancePromptInput): Promise<string> {
  'use step';
  return buildMaintenancePromptForFlow(input);
}