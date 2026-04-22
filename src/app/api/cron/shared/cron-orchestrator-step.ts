/**
 * Orchestrator LLM pass (instance_plan, sandbox investigate, etc.) — 'use step' bundle.
 */
'use step';

import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import { routeTools } from '@/app/api/agents/tools/tool_lookup/assistantProtocol';
import { detectPlanningLoop, type AssistantToolCallSnapshot } from './loop-detectors';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

/**
 * Tool set for the cron orchestrator — routed through `tool_lookup`.
 *
 * Rationale: the full `getAssistantTools()` exposes 40+ marketing/messaging
 * tools. With Gemini that catalogue distracts the planner — in practice it
 * loops exploring the sandbox with `sandbox_run_command` / `sandbox_list_files`
 * and never reaches `instance_plan create`, leaving the requirement stuck
 * in-progress and making the cron pick it up again forever.
 *
 * Solution (MCP-style routing, mirrors `skill_lookup`): expose only the
 * "always-on" minimal surface and put every other tool behind a single
 * `tool_lookup` router. The model discovers tools via
 *   tool_lookup({ action: "list" })  →  ({ action: "describe", name })
 *   → ({ action: "call", name, args }).
 *
 * Always-on (visible schemas):
 *   - Sandbox + skills: skill_lookup, sandbox_run_command, sandbox_read_file,
 *     sandbox_list_files, sandbox_write_file, sandbox_push/restore_checkpoint,
 *     plus any tool whose name starts with "sandbox_" or "qa_".
 *   - Plan + status contract: instance_plan, requirement_status, requirements.
 *   - The router itself: tool_lookup.
 *
 * Behind `tool_lookup` (schema NOT loaded until requested):
 *   media, messaging, CRM/growth, social, content, infra, research — every
 *   other tool from getAssistantTools().
 *
 * Each plan step executor still receives a full catalog (also routed, via
 * `inline-step-executor.ts`), so every capability is preserved at execution
 * time — the router just avoids flooding the context window.
 */
function collectToolCallSnapshots(messages: any[]): AssistantToolCallSnapshot[] {
  const out: AssistantToolCallSnapshot[] = [];
  for (const m of messages) {
    const toolCalls = (m as any)?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const name = tc?.function?.name;
      if (typeof name !== 'string') continue;
      let command: string | undefined;
      if (name === 'sandbox_run_command') {
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          if (typeof args?.command === 'string') command = args.command;
          else if (Array.isArray(args?.args)) command = [args?.cmd, ...args.args].filter(Boolean).join(' ');
        } catch { /* ignore */ }
      }
      out.push({ name, command });
    }
  }
  return out;
}

function getCronOrchestratorTools(
  sandboxTools: any[],
  siteId: string,
  instanceId: string,
  userId: string,
): any[] {
  // getAssistantTools already prepends customTools, so passing sandboxTools
  // here makes sure skill_lookup + sandbox_* stay in the always-on bucket
  // after partitioning.
  const allTools = getAssistantTools(siteId, userId, instanceId, sandboxTools);
  return routeTools(allTools);
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
  const routedCount = fullTools.find((t: any) => t?.name === 'tool_lookup') ? 1 : 0;
  console.log(
    `[CronStep] Orchestrator tools visible to LLM: ${fullTools.length} (always-on + tool_lookup=${routedCount}). Routed tools are discoverable via tool_lookup.`,
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

  const orchestratorModel = process.env.AI_CODE_MODEL || 'gemini-3.1-pro-preview-customtools';

  while (!isDone && turns < MAX_TURNS) {
    turns++;
    try {
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
          ai_model: orchestratorModel,
        },
      );
    } catch (rawErr: any) {
      // Re-throw a *plain* Error with a serializable, TRUNCATED message so
      // Vercel Workflow can record it inline on the `run_failed` event.
      // Previously we attached `cause`, `status`, `provider`, `model` as extra
      // properties — when the payload grew past the inline limit, the workflow
      // runtime stored the whole error as a `RemoteRef` in S3, and the
      // `run_failed` Zod schema then rejected it with
      // `run.error: expected object, received undefined`, leaving the run in a
      // half-broken state with no usable diagnostic.
      //
      // Log everything we know (status, body, request_id…) here so operators
      // still have context, but only re-throw the compact summary.
      const status = rawErr?.status ?? rawErr?.response?.status;
      const body = rawErr?.error || rawErr?.response?.data;
      const rawMsg = typeof rawErr?.message === 'string' ? rawErr.message : String(rawErr);
      const summary = [
        `Orchestrator failed at turn ${turns}`,
        `provider=openai-compat`,
        `model=${orchestratorModel}`,
        `tools=${fullTools.length}`,
        `messages=${messages.length}`,
        status !== undefined ? `status=${status}` : null,
        rawErr?.code ? `code=${rawErr.code}` : null,
        rawErr?.request_id ? `request_id=${rawErr.request_id}` : null,
        rawMsg ? `message=${rawMsg.slice(0, 512)}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      console.error(`[CronStep] ${summary}`, body ? { body } : '');
      // Hard cap at 2KB so Vercel Workflow never has to spill this to S3.
      const flat = new Error(summary.length > 2048 ? summary.slice(0, 2048) + '…' : summary);
      throw flat;
    }
    messages = result.messages;
    isDone = result.isDone;

    // Loop detector: planning loop. Inject STOP feedback and freeze the
    // remaining budget so the same drift does not consume more turns.
    const callSnapshots = collectToolCallSnapshots(messages);
    const planningVerdict = detectPlanningLoop(callSnapshots);
    if (planningVerdict.triggered && !isDone) {
      console.warn(
        `[CronStep] ${planningVerdict.reason} → injecting STOP feedback and freezing remaining turns.`,
      );
      messages = [
        ...messages,
        { role: 'user', content: planningVerdict.feedback ?? 'STOP planning loop.' },
      ];
      isDone = true;
    }

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
            'REMINDER (system): Your deliverable is an `instance_plan` tied to the CURRENT PHASE and ONE backlog item (WIP=1).',
            'Stop running additional sandbox_* commands unless you are blocked.',
            'IMMEDIATE NEXT ACTIONS:',
            '  1. Call `requirement_backlog` with `action="list"` to see the current phase and pending queue. If empty, `action="upsert"` 3-8 items first.',
            '  2. Pick the single next pending item and call `action="start"` to mark it in_progress (WIP=1 is enforced).',
            '  3. Call `instance_plan` with `action="create"`. Every step MUST set `skill` AND `metadata.backlog_item_id=<id>`.',
            '  4. Call `requirement_status` with `status="in-progress"`.',
            'Do not stop with an assistant text message until the plan is created. Do not touch done items; do not open a second in_progress item.',
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
