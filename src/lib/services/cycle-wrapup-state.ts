import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isCustomerDecisionBlocker } from './requirement-backlog-blockers';
import type { BacklogBlocker, BacklogItem } from './requirement-backlog-types';
import { sanitizeHarnessData } from './harness-diagnostics/context';
import { technicalReviewBacklogItems } from './cycle-wrapup-prompt';
import { classifyRequirementType, getFlow, productAttemptLimits } from './requirement-flows';

/** Never turn a legacy boolean, prose question, or dependency placeholder into customer authority. */
export async function loadCycleInterventionState(requirementId: string, siteId: string): Promise<{
  userDecisionBlockers: BacklogBlocker[]; technicalReviewRequired: boolean;
} | null> {
  const { data, error } = await Promise.resolve(supabaseAdmin.from('requirements').select('backlog,type')
    .eq('id', requirementId).eq('site_id', siteId).maybeSingle()).catch(() => ({ data: null, error: true }));
  // Unknown is not an empty decision list: reporting must not reclassify a real prerequisite.
  if (error || !data) return null;
  if (data.backlog == null) return { userDecisionBlockers: [], technicalReviewRequired: false };
  if (!Array.isArray(data.backlog.items)) return null;
  const blockers = (data.backlog.items as BacklogItem[])
    .filter(item => item.status !== 'done')
    .flatMap(item => Array.isArray(item.blocked_by) ? item.blocked_by : [])
    .filter(blocker => blocker && isCustomerDecisionBlocker(blocker));
  return {
    userDecisionBlockers: sanitizeHarnessData(Array.from(new Map(blockers.map(blocker => [blocker.blocker_id, blocker])).values())) as BacklogBlocker[],
    technicalReviewRequired: technicalReviewBacklogItems(data.backlog.items,
      productAttemptLimits(getFlow(classifyRequirementType(data.type)))).length > 0,
  };
}