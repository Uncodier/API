'use step';

import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { Sandbox } from '@vercel/sandbox';
import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

function getMaintenanceTools(
  sandboxTools: any[],
  siteId: string,
  instanceId: string,
  userId: string,
): any[] {
  const allTools = getAssistantTools(siteId, userId, instanceId, sandboxTools);
  return allTools;
}

export async function runMaintenanceAgentStep(params: {
  sandboxId: string;
  reqId: string;
  requirementType: string;
  maintenancePrompt: string;
  instanceId: string;
  site_id: string;
  user_id: string;
  initialMessage: string;
  git_repo_kind?: 'applications' | 'automation';
  requirementTitle?: string;
  globalStartTime?: number;
}) {
  'use step';
  const {
    sandboxId,
    reqId,
    requirementType,
    maintenancePrompt,
    instanceId,
    site_id,
    user_id,
    initialMessage,
    git_repo_kind = 'applications',
    requirementTitle,
  } = params;

  const instanceType = git_repo_kind === 'automation' ? 'automation' : 'applications';
  const audit: CronAuditContext | undefined = site_id
    ? { instanceId, siteId: site_id, userId: user_id, requirementId: reqId }
    : undefined;
    
  let effectiveSandboxId = sandboxId;
  let sandbox: Sandbox;
  
  try {
    const connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId: reqId,
      instanceType,
      title: requirementTitle?.trim() || reqId,
      audit,
    });
    sandbox = connected.sandbox;
    effectiveSandboxId = connected.sandboxId;
  } catch (err: unknown) {
    console.error(`[MaintenanceStep] 🚨 CRITICAL ERROR: connectOrRecreateRequirementSandbox failed:`, err);
    throw err;
  }

  const sandboxTools = getSandboxTools(sandbox, reqId, {
    site_id,
    instance_id: instanceId,
    git_repo_kind,
    requirement_type: requirementType,
  });

  const fullTools = getMaintenanceTools(sandboxTools, site_id, instanceId, user_id);

  const MAX_TURNS = 25;
  let turns = 0;
  let isDone = false;
  let result: any;
  let messages: any[] = [{ role: 'user', content: initialMessage }];

  const agentModel = process.env.AI_CODE_MODEL || 'gemini-3.1-pro-preview-customtools';
  const globalStartTime = params.globalStartTime ?? Date.now();
  const MAX_EXECUTION_TIME_MS = 12 * 60 * 1000; // 12 minutes
  let timedOut = false;

  const { supabaseAdmin } = await import('@/lib/database/supabase-client');

  // Fetch last instance plan context to prevent agents from creating plans in the wrong instance or losing track
  const { data: lastPlans } = await supabaseAdmin
    .from('instance_plans')
    .select('*')
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(1);

  let instance_plan_id = null;
  let activeStepContext = '';
  let allStepsContext = '';
  
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
  }

  const instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${site_id}\n- User ID: ${user_id}${instance_plan_id ? `\n- Current Plan ID: ${instance_plan_id}` : ''}${allStepsContext}${activeStepContext}\n\n⚠️ CRITICAL: ALWAYS use instance_id="${instanceId}" when calling instance_plan. Do NOT use any other instance_id you might find in history.\n`;

  const finalPrompt = maintenancePrompt + instanceContext;

  while (!isDone && turns < MAX_TURNS) {
    if (Date.now() - globalStartTime > MAX_EXECUTION_TIME_MS) {
      console.log(`[MaintenanceStep] Agent reached max execution time (${MAX_EXECUTION_TIME_MS}ms). Halting to prevent Vercel timeout.`);
      timedOut = true;
      break;
    }

    turns++;
    try {
      result = await executeAssistantStep(
        messages,
        { id: instanceId, site_id, user_id, requirement_id: reqId },
        {
          use_sdk_tools: false,
          provider: 'gemini',
          ai_provider: 'gemini',
          instance_id: instanceId,
          site_id,
          user_id,
          system_prompt: finalPrompt,
          custom_tools: fullTools,
          ai_model: agentModel,
        },
      );
    } catch (rawErr: any) {
      console.error(`[MaintenanceStep] Execution failed at turn ${turns}:`, rawErr);
      throw rawErr;
    }
    messages = result.messages;
    isDone = result.isDone;
  }

  console.log(`[MaintenanceStep] Agent finished after ${turns} turn(s) (isDone=${isDone}, timedOut=${timedOut})`);
  return { turns, effectiveSandboxId, timedOut };
}
