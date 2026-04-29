'use step';
/**
 * Durable step wrappers for DB calls that would otherwise run inside the
 * workflow VM and hit the `fetch` restriction:
 *
 *   Global "fetch" is unavailable in workflow functions.
 *   Use the "fetch" step function from "workflow" to make HTTP requests.
 *   https://useworkflow.dev/err/fetch-in-workflow
 *
 * These live in their own module (not in `cron-steps.ts`) because:
 *   - The SWC `swc-workflow-plugin` forbids re-exports from `'use step'`
 *     files, so each step has to be declared where callers import from.
 *   - Keeps `cron-steps.ts` under the 500-line budget.
 */

import { listBacklog } from '@/lib/services/requirement-backlog';
import type { RequirementBacklog } from '@/lib/services/requirement-backlog-types';
import { createRequirementStatusCore } from '@/lib/tools/requirement-status-core';

export interface BacklogSnapshotStepResult {
  backlog: RequirementBacklog | null;
  error?: string;
}

/**
 * Reads the current backlog for a requirement. Always resolves — never
 * throws — so the workflow can fall back to the "empty backlog" branch of
 * the prompt builder when the row is missing or Supabase is unreachable.
 */
export async function getBacklogSnapshotStep(
  requirementId: string,
): Promise<BacklogSnapshotStepResult> {
  'use step';
  try {
    const snap = await listBacklog(requirementId);
    return { backlog: snap.backlog };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[WorkflowDbStep] backlog snapshot unavailable for req ${requirementId}: ${msg}`,
    );
    return { backlog: null, error: msg };
  }
}

export interface RecordRequirementBlockedInput {
  site_id: string;
  instance_id: string;
  requirement_id: string;
  message: string;
}

export interface RecordRequirementBlockedResult {
  ok: boolean;
  error?: string;
}

/**
 * Records a `status='blocked'` entry on the requirement. Used by the
 * workflow safety nets (re-plan loop guard, orchestrator-no-plan fallback)
 * so those code paths do not call `createRequirementStatusCore` from the
 * workflow VM.
 */
export async function recordRequirementBlockedStep(
  input: RecordRequirementBlockedInput,
): Promise<RecordRequirementBlockedResult> {
  'use step';
  try {
    await createRequirementStatusCore({
      site_id: input.site_id,
      instance_id: input.instance_id,
      requirement_id: input.requirement_id,
      stage: 'blocked',
      message: input.message,
    });
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[WorkflowDbStep] Failed to record blocked status for req ${input.requirement_id}: ${msg}`,
    );
    return { ok: false, error: msg };
  }
}

export async function checkInstanceAndPlanStatusStep(instanceId: string): Promise<{ isPaused: boolean }> {
  'use step';
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    
    const { data: instanceData } = await supabaseAdmin
      .from('remote_instances')
      .select('status')
      .eq('id', instanceId)
      .single();

    const { data: activePlan } = await supabaseAdmin
      .from('instance_plans')
      .select('status')
      .eq('instance_id', instanceId)
      .in('status', ['pending', 'in_progress', 'paused'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return {
      isPaused: instanceData?.status === 'paused' || activePlan?.status === 'paused'
    };
  } catch (e: unknown) {
    console.warn(`[WorkflowDbStep] Failed to check paused status for instance ${instanceId}:`, e);
    return { isPaused: false };
  }
}

export async function unblockRequirementStep(requirementId: string, forceStatusToInProgress = false): Promise<void> {

  'use step';
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { data } = await supabaseAdmin.from('requirements').select('metadata, status').eq('id', requirementId).single();
    
    const newMetadata = data?.metadata ? { ...data.metadata, cron_attempts: 0 } : { cron_attempts: 0 };
    
    const updatePayload: any = {
      metadata: newMetadata,
      updated_at: new Date().toISOString()
    };

    if (forceStatusToInProgress || data?.status === 'blocked') {
      updatePayload.status = 'in-progress';
    }
    
    await supabaseAdmin.from('requirements').update(updatePayload).eq('id', requirementId);
    
    console.log(`[WorkflowDbStep] Successfully unblocked req ${requirementId} and reset cron_attempts`);
  } catch (e: unknown) {
    console.warn(`[WorkflowDbStep] Failed to unblock req ${requirementId}:`, e);
  }
}

export async function incrementQaSuccessfulRunsStep(requirementId: string): Promise<void> {
  'use step';
  try {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { data } = await supabaseAdmin.from('requirements').select('metadata').eq('id', requirementId).single();
    
    const currentRuns = data?.metadata?.qa_successful_runs || 0;
    const newMetadata = data?.metadata 
      ? { ...data.metadata, qa_successful_runs: currentRuns + 1 } 
      : { qa_successful_runs: 1 };
    
    await supabaseAdmin.from('requirements').update({
      metadata: newMetadata,
      updated_at: new Date().toISOString()
    }).eq('id', requirementId);
    
    console.log(`[WorkflowDbStep] Incremented qa_successful_runs for req ${requirementId} to ${currentRuns + 1}`);
  } catch (e: unknown) {
    console.warn(`[WorkflowDbStep] Failed to increment qa_successful_runs for req ${requirementId}:`, e);
  }
}
