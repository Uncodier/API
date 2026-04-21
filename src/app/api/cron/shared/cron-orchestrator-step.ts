/**
 * Orchestrator LLM pass (instance_plan, sandbox investigate, etc.) — 'use step' bundle.
 */
'use step';

import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

export async function runOrchestratorStep(params: {
  sandboxId: string;
  reqId: string;
  requirementType: string;
  orchestratorPrompt: string;
  instanceId: string;
  site_id: string;
  user_id: string;
  initialMessage: string;
  git_repo_kind?: 'applications' | 'automation';
  /** Used when reprovisioning the VM (branch title) */
  requirementTitle?: string;
}) {
  'use step';
  const {
    sandboxId,
    reqId,
    requirementType,
    orchestratorPrompt,
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
  const { sandbox, sandboxId: effectiveSandboxId } = await connectOrRecreateRequirementSandbox({
    sandboxId,
    requirementId: reqId,
    instanceType,
    title: requirementTitle?.trim() || reqId,
    audit,
  });
  const sandboxTools = getSandboxTools(sandbox, reqId, {
    site_id,
    instance_id: instanceId,
    git_repo_kind,
    requirement_type: requirementType,
  });
  const allCustomTools = [...sandboxTools];

  const fullTools = getAssistantTools(site_id, user_id, instanceId, allCustomTools);

  const MAX_TURNS = 15;
  let turns = 0;
  let isDone = false;
  let result: any;
  let messages: any[] = [{ role: 'user', content: initialMessage }];

  while (!isDone && turns < MAX_TURNS) {
    turns++;
    result = await executeAssistantStep(
      messages,
      { id: instanceId, site_id, user_id, requirement_id: reqId },
      {
        use_sdk_tools: false,
        provider: 'openai',
        instance_id: instanceId,
        site_id,
        user_id,
        system_prompt: orchestratorPrompt,
        custom_tools: fullTools,
        // Orchestrator drives the sandbox code assistant; mirror the code-model override.
        ai_model: process.env.AI_CODE_MODEL || 'gemini-3.1-pro-preview-customtools',
      },
    );
    messages = result.messages;
    isDone = result.isDone;
  }

  console.log(`[CronStep] Orchestrator finished after ${turns} turn(s)`);
  return { turns, effectiveSandboxId };
}
