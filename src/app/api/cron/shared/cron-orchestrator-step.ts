/**
 * Orchestrator LLM pass (instance_plan, sandbox investigate, etc.) — 'use step' bundle.
 */
'use step';

import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { requirementsTool } from '@/app/api/agents/tools/requirements/assistantProtocol';
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';
import { instancePlanTool } from '@/app/api/agents/tools/instance_plan/assistantProtocol';
import { instanceLogsTool } from '@/app/api/agents/tools/instance_logs/assistantProtocol';
import { memoriesTool } from '@/app/api/agents/tools/memories/assistantProtocol';
import { webSearchTool } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import { instanceTool } from '@/app/api/agents/tools/instance/assistantProtocol';
import { instanceProjectTool } from '@/app/api/agents/tools/instance_project/assistantProtocol';
import { contentTool } from '@/app/api/agents/tools/content/assistantProtocol';
import { tasksTool } from '@/app/api/agents/tools/tasks/assistantProtocol';
import { conversationsTool } from '@/app/api/agents/tools/conversations/assistantProtocol';
import { messagesTool } from '@/app/api/agents/tools/messages/assistantProtocol';
import { reportTool } from '@/app/api/agents/tools/report/assistantProtocol';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

/**
 * Minimal tool set for the cron orchestrator.
 *
 * Rationale: the full `getAssistantTools()` exposes 40+ marketing/messaging tools
 * (email, whatsapp, social, leads, audiences, campaigns, content, etc.). With
 * Gemini that catalogue distracts the planner — in practice it loops exploring
 * the sandbox with `sandbox_run_command` / `sandbox_list_files` and never
 * reaches `instance_plan create`, leaving the requirement stuck in-progress
 * and making the cron pick it up again forever.
 *
 * The orchestrator PLANS + DELEGATES; it does not write code, generate media,
 * or send messages. The tool set below gives it everything it needs to
 * INFORM a good plan + CREATE and TRACK that plan, without distracting it
 * with action tools that belong to executor sub-agents.
 *
 * Included (grouped by purpose):
 *  - Sandbox & skills:
 *      skill_lookup          loads any makinari-* skill (orchestrator /
 *                            planning-phase / role / objective)
 *      sandbox_run_command   targeted shell inspection inside the repo
 *      sandbox_read_file     read source/config/docs
 *      sandbox_list_files    browse structure
 *      sandbox_write_file    (available but orchestrator should delegate)
 *      sandbox_push/restore_checkpoint
 *      + QA sandbox tools
 *  - Plan & status (THE core orchestrator surface):
 *      instance_plan         list → create → update plan steps
 *      requirement_status    report in-progress / blocked / done
 *      requirements          read + update requirement.instructions (brain)
 *      instance_logs         audit trail
 *      memories              recall prior plan patterns for the same site
 *  - Context (read-only / info-gathering for planning):
 *      instance              instance metadata (capabilities, config)
 *      instance_project      project-level metadata
 *      content               existing site content / pages / sections
 *      tasks                 cross-reference task list
 *      conversations         recent user threads (feature requests / bugs)
 *      messages              individual messages within threads
 *      report                historical reports for this site/instance
 *  - External research:
 *      webSearch             look up external references (competitor UX, APIs)
 *
 * NOT exposed (on purpose — these belong to executor sub-agents that run
 * plan steps; exposing them to the orchestrator caused Gemini to loop on
 * "doing" instead of "planning"):
 *   generate_image/video/audio, audioToText, urlToMarkdown/Sitemap,
 *   sendEmail/WhatsApp/BulkMessages, whatsappTemplate, sales/deals/leads/
 *   salesOrder, audience, segments, campaigns, copywriting, icp*,
 *   getFinderCategoryIds, searchRegionVenues, socialMedia*, publish,
 *   scheduling, workflows, webhooks, assets, systemNotification,
 *   updateSiteSettings, createProject, createSecret, createAccount/verify.
 *
 * Each plan step executor still receives the FULL `getAssistantTools()`
 * catalog via `inline-step-executor.ts` (used by `cron-execute-steps-phase`),
 * so every capability above is preserved — just invoked by the right
 * role/skill at execution time (e.g. role=content can call generate_image,
 * role=devops can call createSecret, etc.).
 */
function getCronOrchestratorTools(
  sandboxTools: any[],
  siteId: string,
  instanceId: string,
  userId: string,
): any[] {
  return [
    ...sandboxTools,

    // Plan & status — core orchestrator surface
    instancePlanTool(siteId, instanceId, userId),
    requirementStatusTool(siteId, instanceId),
    requirementsTool(siteId, userId),
    instanceLogsTool(siteId, userId, instanceId),
    memoriesTool(siteId, userId, instanceId),

    // Context (read-only / info-gathering for better planning)
    instanceTool(siteId, instanceId, userId),
    instanceProjectTool(userId),
    contentTool(siteId, userId),
    tasksTool(siteId, userId),
    conversationsTool(siteId, userId),
    messagesTool(siteId),
    reportTool(siteId, userId),

    // External research
    webSearchTool(siteId),
  ];
}

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

  const fullTools = getCronOrchestratorTools(sandboxTools, site_id, instanceId, user_id);
  console.log(
    `[CronStep] Orchestrator tools: ${fullTools.length} (sandbox=${sandboxTools.length}, +requirements/instance_plan/…)`,
  );

  // Gemini tends to explore the sandbox first; 15 turns isn't enough once you
  // add skill_lookup + instance_plan(list) + investigate + plan create. Give
  // it more headroom, and nudge it if it's drifting into pure exploration.
  const MAX_TURNS = 25;
  const PLAN_NUDGE_AFTER_TURN = 6;
  let turns = 0;
  let isDone = false;
  let result: any;
  let messages: any[] = [{ role: 'user', content: initialMessage }];
  let nudged = false;
  let createdPlan = false;

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

    // Track whether the orchestrator ever invoked `instance_plan action="create"`.
    // We detect it from assistant tool_calls rather than results so we don't
    // depend on the executor's internal shape.
    for (const m of messages) {
      const toolCalls = (m as any)?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const tc of toolCalls) {
        if (tc?.function?.name !== 'instance_plan') continue;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          if (args?.action === 'create') {
            createdPlan = true;
          }
        } catch {
          /* ignore malformed args */
        }
      }
    }

    // Nudge once: if after several turns the orchestrator is still only
    // exploring (no instance_plan create yet), remind it that PLANNING is
    // its deliverable. Otherwise the cron loops forever producing no plan.
    if (!isDone && !createdPlan && !nudged && turns >= PLAN_NUDGE_AFTER_TURN) {
      nudged = true;
      console.log(
        `[CronStep] Orchestrator nudge at turn ${turns}: still no instance_plan(create) — injecting reminder.`,
      );
      messages = [
        ...messages,
        {
          role: 'user',
          content: [
            'REMINDER (system): Your deliverable is an `instance_plan` for this requirement, not more exploration.',
            'Stop running additional sandbox_* commands unless you are blocked.',
            'IMMEDIATE NEXT ACTIONS:',
            '  1. If you have not already: call `instance_plan` with `action="list"` and the provided instance_id to avoid duplicates.',
            '  2. If no active plan exists, call `instance_plan` with `action="create"` NOW. Each step MUST set `skill` (preferred, e.g. `makinari-rol-frontend`, `makinari-rol-qa`, `makinari-obj-template-selection`) OR `role` as a fallback. `title` and `instructions` are required.',
            '  3. After creating the plan, call `requirement_status` with `status="in-progress"` so the workflow can proceed.',
            'Do not stop with an assistant text message until the plan is created.',
          ].join('\n'),
        },
      ];
    }
  }

  console.log(
    `[CronStep] Orchestrator finished after ${turns} turn(s) (createdPlan=${createdPlan}, isDone=${isDone})`,
  );
  return { turns, effectiveSandboxId, createdPlan };
}
