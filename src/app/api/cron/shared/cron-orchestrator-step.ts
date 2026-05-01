'use step';
/**
 * Orchestrator LLM pass (instance_plan, sandbox investigate, etc.) — 'use step' bundle.
 */

import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { Sandbox } from '@vercel/sandbox';
import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
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
 *     sandbox_read_logs, plus any tool whose name starts with "sandbox_" or "qa_".
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
  return allTools;
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
  globalStartTime?: number;
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
    console.error(`[CronStep|orchestrator] 🚨 CRITICAL ERROR: connectOrRecreateRequirementSandbox failed in orchestrator:`, err);
    throw err; // Re-throw so the outer workflow catches it and can clean up if needed
  }

  const sandboxTools = getSandboxTools(sandbox, reqId, {
    site_id,
    instance_id: instanceId,
    git_repo_kind,
    requirement_type: requirementType,
  });

  const fullTools = getCronOrchestratorTools(sandboxTools, site_id, instanceId, user_id);
  const routedCount = fullTools.find((t: any) => t?.name === 'tool_lookup') ? 1 : 0;
  console.log(
    `[CronStep|orchestrator] Orchestrator tools visible to LLM: ${fullTools.length} (always-on + tool_lookup=${routedCount}). Routed tools are discoverable via tool_lookup.`,
  );

  // Gemini tends to explore the sandbox first; 15 turns isn't enough once you
  // add skill_lookup + instance_plan(list) + investigate + plan create. Give
  // it more headroom, and nudge it if it's drifting into pure exploration.
  const MAX_TURNS = 25;
  // The coordinator should reach `instance_plan create` within a handful of
  // tool calls (list backlog → upsert → start → create). Firing the nudge
  // after turn 2 catches drift early — the previous threshold of 6 never
  // triggered because models tended to return a plain-text response around
  // turn 3–4, which flipped isDone=true and exited the loop silently.
  const PLAN_NUDGE_AFTER_TURN = 2;
  // Maximum number of times we will override an `isDone=true && !createdPlan`
  // signal by re-injecting the reminder. Prevents an infinite loop if the
  // model never produces tool calls at all, while still giving it a real
  // second chance to emit `instance_plan action='create'`.
  const MAX_NO_PLAN_OVERRIDES = 3;
  let turns = 0;
  let isDone = false;
  let result: any;
  let messages: any[] = [{ role: 'user', content: initialMessage }];
  let nudged = false;
  let createdPlan = false;
  let noPlanOverrides = 0;

  const orchestratorModel = process.env.AI_CODE_MODEL || 'gemini-3.1-preview';

  const globalStartTime = params.globalStartTime ?? Date.now();
  const MAX_EXECUTION_TIME_MS = 4 * 60 * 1000; // 4 minutes

  let timedOut = false;

  while (!isDone && turns < MAX_TURNS) {
    if (Date.now() - globalStartTime > MAX_EXECUTION_TIME_MS) {
      console.log(`[CronStep|orchestrator] Orchestrator reached max execution time (${MAX_EXECUTION_TIME_MS}ms). Saving WIP state and halting to prevent Vercel timeout.`);
      try {
        const { SandboxService } = await import('@/lib/services/sandbox-service');
        await SandboxService.commitAndPush(sandbox, {
          requirementId: reqId,
          title: requirementTitle || reqId,
          message: `WIP: Orchestrator paused due to time limit`,
        });
      } catch (e) {
        console.warn(`[CronStep|orchestrator] Failed to save Orchestrator WIP state:`, e);
      }
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

    // For empty-body 400s (Gemini's openai-compat loves these), the ONLY
    // signal we have is what we sent. Surface the last assistant tool_call
    // name and a small slice of tool names directly in the thrown message
    // so operators see the likely offender in the dashboard without having
    // to correlate with the separate `logChatCompletionFailure` line.
    let lastToolCallName: string | undefined;
    let lastToolMessageName: string | undefined;
    for (let i = messages.length - 1; i >= 0 && (!lastToolCallName || !lastToolMessageName); i--) {
      const m: any = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (!lastToolCallName && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const tc = m.tool_calls[m.tool_calls.length - 1];
        if (typeof tc?.function?.name === 'string') lastToolCallName = tc.function.name;
      }
      if (!lastToolMessageName && m.role === 'tool' && typeof m.name === 'string') {
        lastToolMessageName = m.name;
      }
    }
      const toolNamesPreview = fullTools
        .map((t: any) => t?.function?.name || t?.name)
        .filter((x: unknown): x is string => typeof x === 'string')
        .slice(0, 8)
        .join(',');

      const summary = [
        `Orchestrator failed at turn ${turns}`,
        `provider=openai-compat`,
        `model=${orchestratorModel}`,
        `tools=${fullTools.length}`,
        `messages=${messages.length}`,
        lastToolCallName ? `lastToolCall=${lastToolCallName}` : null,
        lastToolMessageName ? `lastToolMsg=${lastToolMessageName}` : null,
        toolNamesPreview ? `toolNames=[${toolNamesPreview}]` : null,
        status !== undefined ? `status=${status}` : null,
        rawErr?.code ? `code=${rawErr.code}` : null,
        rawErr?.request_id ? `request_id=${rawErr.request_id}` : null,
        rawMsg ? `message=${rawMsg.slice(0, 512)}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      console.error(`[CronStep|orchestrator] ${summary}`, body ? { body } : '');
      // Hard cap at ~1.5KB and drop the stack. The FatalError wrapper that
      // Vercel Workflow builds around us already contributes several hundred
      // bytes of framing; any real stack traces (with /var/task/.next/server
      // frames) push the payload past the inline threshold and force a
      // RemoteRef spill, which then breaks the `run_failed` Zod validation
      // (`run.error: expected object, received undefined`). Without a stack
      // we lose nothing (callers already log the raw error above) and the
      // error stays inline every time.
      const MAX = 1536;
      const flat = new Error(summary.length > MAX ? summary.slice(0, MAX) + '…' : summary);
      flat.stack = flat.message;
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
        `[CronStep|orchestrator] ${planningVerdict.reason} → injecting STOP feedback and freezing remaining turns.`,
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

    const noPlanReminder = [
      'REMINDER (system): Your deliverable is an `instance_plan` tied to the CURRENT PHASE and ONE backlog item (WIP=1).',
      'Stop running additional sandbox_* commands unless you are blocked.',
      'IMMEDIATE NEXT ACTIONS:',
      '  1. Call `requirement_backlog` with `action="list"` to see the current phase and pending queue. If empty, `action="upsert"` 3-8 items derived from the INSTRUCTIONS block (do NOT read `requirement.spec.md` first).',
      '  2. Pick the single next pending item and call `action="start"` to mark it in_progress (WIP=1 is enforced).',
      '  3. Call `instance_plan` with `action="create"`. BREAK DOWN the item into specific execution steps. Do NOT just repeat the item title. Every step MUST set `skill` AND `metadata.backlog_item_id=<id>`. The LAST step MUST ALWAYS be to notify the team using the `system_notification` tool.',
      '  4. Call `requirement_status` with `stage="in-progress"`.',
      'Do not stop with an assistant text message until the plan is created. Do not touch done items; do not open a second in_progress item.',
    ].join('\n');

    // Nudge once: if after a couple of turns the orchestrator is still only
    // exploring (no instance_plan create yet), remind it that PLANNING is
    // its deliverable. Otherwise the cron loops forever producing no plan.
    if (!isDone && !createdPlan && !nudged && turns >= PLAN_NUDGE_AFTER_TURN) {
      nudged = true;
      console.log(
        `[CronStep|orchestrator] Orchestrator nudge at turn ${turns}: still no instance_plan(create) — injecting reminder.`,
      );
      messages = [...messages, { role: 'user', content: noPlanReminder }];
    }

    // Force-continue: the model sometimes returns a plain-text assistant
    // message ("I reviewed the backlog, will create the plan next…") which
    // flips isDone=true before any `instance_plan action='create'` fires.
    // Accepting that signal would let the cron exit empty-handed and pick
    // the same requirement up on the next tick ad infinitum. When we still
    // have budget, inject the same reminder and keep iterating. Capped by
    // MAX_NO_PLAN_OVERRIDES so a truly stuck model cannot burn the whole
    // turn budget on empty assistant messages.
    if (
      isDone &&
      !createdPlan &&
      noPlanOverrides < MAX_NO_PLAN_OVERRIDES &&
      turns < MAX_TURNS
    ) {
      noPlanOverrides++;
      console.warn(
        `[CronStep|orchestrator] Orchestrator returned isDone=true at turn ${turns} without creating a plan — overriding (${noPlanOverrides}/${MAX_NO_PLAN_OVERRIDES}) and re-prompting.`,
      );
      messages = [...messages, { role: 'user', content: noPlanReminder }];
      isDone = false;
    }
  }

  console.log(
    `[CronStep|orchestrator] Orchestrator finished after ${turns} turn(s) (createdPlan=${createdPlan}, isDone=${isDone}, timedOut=${timedOut})`,
  );
  return { turns, effectiveSandboxId, createdPlan, timedOut };
}
