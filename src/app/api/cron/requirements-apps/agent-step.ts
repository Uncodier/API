import { runRequirementCycle } from '@/app/api/robots/instance/assistant/requirement-runtime';
import type { RequirementRun } from '@/lib/harness/requirement-types';

export async function executeRequirementCycle(run: RequirementRun) {
  'use step';
  return runRequirementCycle(run);
}

// The cron recovers the stored session. Workflow must not replay an entire multi-effect slice.
executeRequirementCycle.maxRetries = 0;