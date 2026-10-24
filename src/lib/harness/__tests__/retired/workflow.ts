// Historical regression fixture only.
import { executeRequirementCycle } from './agent-step';
import type { RequirementRun } from '@/lib/harness/requirement-types';

/** One owned agent slice per existing cron tick. The next tick resumes the same session. */
export async function runCronAppsWorkflow(run: RequirementRun) {
  'use workflow';
  return executeRequirementCycle(run);
}