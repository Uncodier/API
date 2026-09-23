import { supabaseAdmin } from '@/lib/database/supabase-client';
import { listBacklog } from '@/lib/services/requirement-backlog';
import type { RequirementBacklog } from '@/lib/services/requirement-backlog-types';
import { fetchMemoriesContext, generateAgentBackground } from '@/app/api/robots/instance/assistant/utils';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import { formatRunnerExecutionHistory } from './requirement-context-history';

export interface FullRequirementContext {
  backlog: RequirementBacklog | null;
  progress: string[] | null;
  requirementDetailsContext: string;
  previousWorkContext: string;
  agentBackground: string;
  memoriesContext: string;
  historyContext: string;
  instanceContext: string;
}

export class RequirementContextService {
  /**
   * Fetches the comprehensive context needed by an AI agent (Orchestrator or QA)
   * to continue working on a requirement, preventing context loss between cycles.
   */
  static async getFullContext(
    reqId: string,
    instanceId: string,
    siteId: string,
    userId: string
  ): Promise<FullRequirementContext> {
    
    // 1. Fetch Backlog, Progress & Requirement Details
    let backlog: RequirementBacklog | null = null;
    let progress: string[] | null = null;
    let requirementDetailsContext = '';
    
    const [backlogSnapshot, requirementSnapshot] = await Promise.all([
      listBacklog(reqId)
        .then((snap) => snap.backlog)
        .catch((error: unknown) => {
          console.warn(
            `[RequirementContext] backlog snapshot unavailable for req ${reqId}:`,
            error,
          );
          return null;
        }),
      (async () => {
        try {
          const { data } = await supabaseAdmin
            .from('requirements')
            .select('id, title, description, instructions, type, priority, status, progress')
            .eq('id', reqId)
            .single();
          return data;
        } catch (error: unknown) {
          console.warn(
            `[RequirementContext] progress snapshot unavailable for req ${reqId}:`,
            error,
          );
          return null;
        }
      })(),
    ]);
    backlog = backlogSnapshot;
    if (requirementSnapshot) {
      if (
        requirementSnapshot.progress &&
        Array.isArray(requirementSnapshot.progress)
      ) {
        progress = requirementSnapshot.progress;
      }

      requirementDetailsContext = '\n\n📋 CURRENT REQUIREMENT DETAILS:\n';
      requirementDetailsContext += JSON.stringify({
        id: requirementSnapshot.id,
        title: requirementSnapshot.title,
        description: requirementSnapshot.description,
        instructions: requirementSnapshot.instructions,
        type: requirementSnapshot.type,
        priority: requirementSnapshot.priority,
        status: requirementSnapshot.status,
      }, null, 2);
    }

    // 2. Build Previous Work Context (Blockers, Past Stages, Past Plans)
    let previousWorkContext = '';
    try {
      const [{ data: prevStatuses }, { data: prevPlans }] = await Promise.all([
        supabaseAdmin
          .from('requirement_status')
          .select('stage, message, preview_url, repo_url, created_at')
          .eq('requirement_id', reqId)
          .order('created_at', { ascending: false })
          .limit(10),
        supabaseAdmin
          .from('instance_plans')
          .select('id, title, status, steps')
          .eq('instance_id', instanceId)
          .order('created_at', { ascending: false })
          .limit(3),
      ]);

      const latestStatus = prevStatuses?.[0];
      let blockerContext = '';
      if (latestStatus && latestStatus.stage !== 'done') {
        const blockers: string[] = [];
        if (latestStatus.message?.includes('preview_url returns error/404')) {
          blockers.push('CRITICAL: The deployed preview URL returns 404. The app has no working root page. You MUST create a plan step to fix the root route (e.g. src/app/page.tsx).');
        }
        if (latestStatus.message?.includes('no push')) {
          blockers.push('WARNING: Last cycle produced no git push. The agent must write actual files, not just update metadata.');
        }
        if (latestStatus.message?.includes('plan not completed')) {
          blockers.push('WARNING: Last cycle failed because you did not call the `instance_plan` tool with action="create". You MUST use the `instance_plan` tool to create the execution plan for the current backlog item. Do not try to fix code; just create the plan.');
        }
        if (!latestStatus.preview_url) {
          blockers.push(
            'DELIVERY CHECK PENDING: No preview URL is available. This blocks only deployment/browser validation; continue any source, test, or documentation work that does not require the preview.',
          );
        }
        if (blockers.length) {
          blockerContext = `\n⚠️ SCOPED ISSUES FROM LAST CYCLE:\n${blockers.map(b => `- ${b}`).join('\n')}\n`;
        }
      }

      previousWorkContext = [
        blockerContext,
        (prevStatuses?.length || prevPlans?.length)
          ? `\nPREVIOUS WORK:\n${prevStatuses?.length ? `- Latest stage: ${latestStatus?.stage} — ${latestStatus?.message || 'no message'}` : ''}\n${prevPlans?.length ? `- Recent plans: ${prevPlans.map((p: any) => `${p.title} (${p.status})`).join(', ')}` : ''}\n`
          : '',
      ].filter(Boolean).join('\n');
    } catch (e: unknown) {
      console.warn(`[RequirementContext] previous work context unavailable for req ${reqId}:`, e);
    }

    // 3. Instance Plan Context
    let instanceContext = '';
    try {
      const [{ data: lastPlans }, { data: lastCompletedPlans }] =
        await Promise.all([
          supabaseAdmin
            .from('instance_plans')
            .select('*')
            .eq('instance_id', instanceId)
            .order('created_at', { ascending: false })
            .limit(1),
          supabaseAdmin
            .from('instance_plans')
            .select('title')
            .eq('instance_id', instanceId)
            .eq('status', 'completed')
            .order('completed_at', { ascending: false })
            .limit(1),
        ]);

      let instance_plan_id = null;
      let activeStepContext = '';
      let allStepsContext = '';
      let lastCompletedPlanContext = '';

      if (lastPlans && lastPlans.length > 0) {
        const activePlan = lastPlans[0];
        instance_plan_id = activePlan.id;

        if (activePlan.steps && Array.isArray(activePlan.steps)) {
          const stepsSummary = activePlan.steps.map((s: any) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            order: s.order
          }));
          allStepsContext = `\n- Plan Steps: ${JSON.stringify(stepsSummary)}`;

          const inProgressStep = activePlan.steps.find((s: any) => s.status === 'in_progress');
          const pendingStep = activePlan.steps.find((s: any) => s.status === 'pending');
          const step = inProgressStep || pendingStep;
          if (step) {
            activeStepContext = `\n- Active Step Object: ${JSON.stringify(step)}\n\n⚠️ IMPORTANT: If you need to call instance_plan with action="execute_step", you MUST use the 'id' field from the 'Active Step Object' above or from the 'Plan Steps' list. DO NOT call action="list" to find the step ID.`;
          } else {
            activeStepContext = `\n\n⚠️ IMPORTANT: To call instance_plan with action="execute_step", you MUST use the 'id' from the 'Plan Steps' list above. DO NOT call action="list" to find the step ID.`;
          }
        }
      } else {
         activeStepContext = `\n\n⚠️ IMPORTANT: There is NO ACTIVE PLAN. If you need a plan, you MUST call instance_plan with action="create". DO NOT call action="list" searching for a plan that doesn't exist.`;
      }
      
      if (lastCompletedPlans && lastCompletedPlans.length > 0) {
        lastCompletedPlanContext = `\n- Last Completed Plan: "${lastCompletedPlans[0].title}"`;
      }

      instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${siteId}\n- User ID: ${userId}${instance_plan_id ? `\n- Current Plan ID: ${instance_plan_id}` : ''}${allStepsContext}${activeStepContext}${lastCompletedPlanContext}\n\n⚠️ CRITICAL: ALWAYS use instance_id="${instanceId}" when calling instance_plan. Do NOT use any other instance_id you might find in history.\n`;
    } catch (e: unknown) {
      console.warn(`[RequirementContext] instance context unavailable for instance ${instanceId}:`, e);
      instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${siteId}\n- User ID: ${userId}\n\n⚠️ CRITICAL: ALWAYS use instance_id="${instanceId}" when calling instance_plan. Do NOT use any other instance_id you might find in history.\n`;
    }

    // 4. Background, Memories, History
    let historyContext = '';
    const [
      agentBackground,
      memoriesContext,
      userHistory,
      historicalLogResult,
    ] = await Promise.all([
      generateAgentBackground(siteId).catch(() => ''),
      fetchMemoriesContext(siteId, userId, instanceId).catch(() => ''),
      loadUserActionHistory(instanceId, {
        requirementId: reqId,
        maxTotalBytes: 12 * 1024,
        headN: 5,
        tailN: 10,
        hardCap: 150,
        maxMessageBytes: 2 * 1024,
      }).catch(() => null),
      (async () => {
        try {
          return await supabaseAdmin
            .from('instance_logs')
            .select('log_type, message, created_at, tool_name, tool_result')
            .eq('instance_id', instanceId)
            .in('log_type', ['agent_action', 'execution_summary', 'tool_call'])
            .order('created_at', { ascending: false })
            .limit(50);
        } catch {
          return { data: null };
        }
      })(),
    ]);

    if (userHistory?.mode !== 'empty' && userHistory?.promptText) {
      historyContext = `\n\n${userHistory.promptText}`;
    }

    historyContext += formatRunnerExecutionHistory(
      historicalLogResult.data,
    );

    return {
      backlog,
      progress,
      requirementDetailsContext,
      previousWorkContext,
      agentBackground,
      memoriesContext,
      historyContext,
      instanceContext,
    };
  }
}
