import { supabaseAdmin } from '@/lib/database/supabase-client';
import { listBacklog } from '@/lib/services/requirement-backlog';
import type { RequirementBacklog } from '@/lib/services/requirement-backlog-types';
import { fetchMemoriesContext, generateAgentBackground } from '@/app/api/robots/instance/assistant/utils';

export interface FullRequirementContext {
  backlog: RequirementBacklog | null;
  progress: string[] | null;
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
    
    // 1. Fetch Backlog & Progress
    let backlog: RequirementBacklog | null = null;
    let progress: string[] | null = null;
    try {
      const snap = await listBacklog(reqId);
      backlog = snap.backlog;
    } catch (e: unknown) {
      console.warn(`[RequirementContext] backlog snapshot unavailable for req ${reqId}:`, e);
    }

    try {
      const { data: reqData } = await supabaseAdmin
        .from('requirements')
        .select('progress')
        .eq('id', reqId)
        .single();
        
      if (reqData?.progress && Array.isArray(reqData.progress)) {
        progress = reqData.progress;
      }
    } catch (e: unknown) {
      console.warn(`[RequirementContext] progress snapshot unavailable for req ${reqId}:`, e);
    }

    // 2. Build Previous Work Context (Blockers, Past Stages, Past Plans)
    let previousWorkContext = '';
    try {
      const { data: prevStatuses } = await supabaseAdmin
        .from('requirement_status')
        .select('stage, message, preview_url, repo_url, created_at')
        .eq('requirement_id', reqId)
        .order('created_at', { ascending: false })
        .limit(10);

      const { data: prevPlans } = await supabaseAdmin
        .from('instance_plans')
        .select('id, title, status, steps')
        .eq('instance_id', instanceId)
        .order('created_at', { ascending: false })
        .limit(3);

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
          blockers.push('WARNING: Last plan did not complete all steps. Review failed steps and address root causes.');
        }
        if (!latestStatus.preview_url) {
          blockers.push('No preview URL available yet. Ensure code changes are meaningful so the deployment works.');
        }
        if (blockers.length) {
          blockerContext = `\n⚠️ BLOCKERS FROM LAST CYCLE (MUST ADDRESS FIRST):\n${blockers.map(b => `- ${b}`).join('\n')}\n`;
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
      const { data: lastPlans } = await supabaseAdmin
        .from('instance_plans')
        .select('*')
        .eq('instance_id', instanceId)
        .order('created_at', { ascending: false })
        .limit(1);

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
      
      const { data: lastCompletedPlans } = await supabaseAdmin
        .from('instance_plans')
        .select('title')
        .eq('instance_id', instanceId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1);

      if (lastCompletedPlans && lastCompletedPlans.length > 0) {
        lastCompletedPlanContext = `\n- Last Completed Plan: "${lastCompletedPlans[0].title}"`;
      }

      instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${siteId}\n- User ID: ${userId}${instance_plan_id ? `\n- Current Plan ID: ${instance_plan_id}` : ''}${allStepsContext}${activeStepContext}${lastCompletedPlanContext}\n\n⚠️ CRITICAL: ALWAYS use instance_id="${instanceId}" when calling instance_plan. Do NOT use any other instance_id you might find in history.\n`;
    } catch (e: unknown) {
      console.warn(`[RequirementContext] instance context unavailable for instance ${instanceId}:`, e);
      instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${siteId}\n- User ID: ${userId}\n\n⚠️ CRITICAL: ALWAYS use instance_id="${instanceId}" when calling instance_plan. Do NOT use any other instance_id you might find in history.\n`;
    }

    // 4. Background, Memories, History
    let agentBackground = '';
    let memoriesContext = '';
    let historyContext = '';
    
    try {
      agentBackground = await generateAgentBackground(siteId);
    } catch(e) {}
    
    try {
      memoriesContext = await fetchMemoriesContext(siteId, userId, instanceId);
    } catch(e) {}
    
    try {
      const { data: rawHistoricalLogs } = await supabaseAdmin
        .from('instance_logs')
        .select('log_type, message, created_at, tool_name, tool_result')
        .eq('instance_id', instanceId)
        .in('log_type', ['user_action', 'agent_action', 'execution_summary', 'tool_call'])
        .order('created_at', { ascending: false })
        .limit(50);

      const historicalLogs = rawHistoricalLogs ? [...rawHistoricalLogs].reverse() : [];
      if (historicalLogs && historicalLogs.length > 0) {
        historyContext = '\n\n📋 CONVERSATION HISTORY:\n';
        historicalLogs.forEach((log) => {
          const timestamp = new Date(log.created_at).toLocaleTimeString();
          const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
          
          if (log.log_type === 'tool_call' && log.tool_name && log.tool_result) {
            if (['generate_image', 'generate_video'].includes(log.tool_name)) {
                const toolResult = log.tool_result;
                const outputKey = log.tool_name === 'generate_image' ? 'images' : 'videos';
                if (toolResult.success && toolResult.output && toolResult.output[outputKey]) {
                  const urls = toolResult.output[outputKey].map((item: any) => item.url).filter(Boolean);
                  if (urls.length > 0) {
                    historyContext += `[${timestamp}] ${role}: Generated ${log.tool_name} - URLs: ${urls.join(', ')}\n`;
                  } else {
                    historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
                  }
                } else {
                  historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
                }
            } else {
              historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
            }
          } else {
            historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
          }
        });
      }
    } catch(e) {}

    return {
      backlog,
      progress,
      previousWorkContext,
      agentBackground,
      memoriesContext,
      historyContext,
      instanceContext,
    };
  }
}
