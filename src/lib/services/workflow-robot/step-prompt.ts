import { SkillsService } from '@/lib/services/skills-service';
import { interpolateWorkflowText, formatWorkflowValidationPrompt } from './retry';

export function buildWorkflowStepPrompt(params: {
  plan: any;
  step: any;
  dryRun: boolean;
  triggerPayload: Record<string, unknown>;
  previousOutputs: Record<string, unknown>;
  instanceId: string;
  siteId: string;
  retryContext?: string;
  sandboxTools?: any[];
  sandboxEnvironmentKeys?: string[];
  browserReady?: boolean;
  preResponseOnly?: boolean;
  relationPrompt?: string;
  /** Host-selected contract; absent/legacy keeps its existing tool-use obligation. */
  resultContractVersion?: number;
}): string {
  const skillName = params.step.skill || 'makinari-rol-workflow-step';
  const matched = SkillsService.getSkillBySlugOrName(skillName);
  const skillBlock = matched
    ? `\n\n--- SKILL: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`
    : params.step.skill
      ? `\nAssigned skill unavailable: ${skillName}. Report that it could not be loaded; do not invent its instructions or create a replacement workflow. If its guidance is essential, report the missing dependency through plan_result.\n`
      : '';
  const mcpHints = (params.preResponseOnly ? [] : params.step.metadata?.mcp_actions || [])
    .map((a: { tool: string; action?: string; hint?: string }) =>
      `- ${a.tool}${a.action ? ` action=${a.action}` : ''}${a.hint ? `: ${a.hint}` : ''}`)
    .join('\n');

  const ctx = {
    trigger: params.triggerPayload,
    steps: params.previousOutputs,
  };
  const instructions = interpolateWorkflowText(params.step.instructions || '', ctx);
  const expected = interpolateWorkflowText(params.step.expected_output || '', ctx);
  const validationBlock = formatWorkflowValidationPrompt(params.step, (text) =>
    interpolateWorkflowText(text, ctx),
  );
  const browserDomains = Array.isArray(params.step.browser_allowed_domains)
    ? params.step.browser_allowed_domains
    : params.step.metadata?.browser_allowed_domains || [];

  const sandboxInstruction = params.step.requires_sandbox || params.step.metadata?.requires_sandbox
    ? `This step has requires_sandbox=true. sandbox_* tools are available. Do not call sandbox_* on steps without this flag.${
        params.sandboxTools && params.sandboxTools.length > 0
          ? `\nAvailable sandbox tools for this step:\n${params.sandboxTools.map((t: any) => `- ${t.name}`).join('\n')}`
          : ''
      }${
        params.browserReady
          ? '\nBrowser navigation is pre-provisioned. Use sandbox_browser directly; do not install agent-browser or Chrome.'
          : ''
      }${
        params.sandboxEnvironmentKeys?.length
          ? `\nAvailable credential names: ${params.sandboxEnvironmentKeys.join(', ')}. Values are not present in process.env. Use value_env only on trusted domains: ${browserDomains.join(', ') || '(none configured)'}.`
          : '\nNo custom workflow environment variables are configured.'
      }`
    : 'This step has NO sandbox. Do not call sandbox_* tools.';

  const executionModeBlock = params.preResponseOnly
    ? `EXECUTION MODE: CHANNEL PRE-RESPONSE (read-only)
Analyze the incoming message and provide useful context for Customer Support. Only plan_result is available. Do NOT send or persist anything; Customer Support alone sends the reply.`
    : params.dryRun
    ? `EXECUTION MODE: DRY RUN (test)
This is a simulation. Read with tools if needed, but do NOT persist CRM/data writes or send messages. Simulate those side effects and include "execution_mode": "dry_run" in plan_result.data.`
    : params.resultContractVersion === 2
    ? `EXECUTION MODE: LIVE (real)
This is a real production run, not a test. Execute real side effects only when authorized and required by the step (CRM writes, notifications, messages). Do not simulate or merely describe required actions as if they happened. Use the supplied context directly when it satisfies the step without external actions.`
    : `EXECUTION MODE: LIVE (real)
This is a real production run, not a test. Call tools via tools and apply real side effects when the step instructions require them (CRM writes, notifications, messages). Do NOT simulate, mock, skip tools, or treat this as a dry run.`;

  const toolInstruction = params.preResponseOnly
    ? 'Do not call business tools. Submit a factual structured plan_result using the message and context given.'
    : params.dryRun
    ? 'Use tools for reads. For writes/sends, describe the simulated outcome instead of executing them.'
    : params.resultContractVersion === 2
    ? 'Use tools when needed to fulfill the step, including every explicitly required action and evidence check. Tool activity alone is not a success criterion. A result based on the supplied context is valid when it satisfies the explicit contract; never fabricate tool results or skip required effects.'
    : 'For steps that match their incoming relation you MUST call tools to fulfill the step. Do not only describe what you would do and never fabricate tool results.';

  return `⚠️ WORKFLOW MODE: You are executing ONE predefined workflow step. Do NOT create or update instance_plan or requirements. Do NOT plan work outside this step.

APPROACH WITHIN THIS STEP:
- Plan proportionally within the assigned instructions and expected output; a broad step may include research, execution and verification without changing the workflow graph. No coding, framework or file layout is assumed.
- Before substantive actions, check for essential missing information. Use the given context or authorized reads where possible; otherwise report the precise missing input through plan_result rather than guessing or sending an unauthorized clarification message. A generic title is not a reason to cancel the plan.
- Choose an effective approach among the tools permitted by this run and the explicit step contract. Additional skill discovery is optional, not a prerequisite. Loaded skills remain applicable but cannot override permissions, execution mode or the terminal protocol below.
- When useful or requested, review the result and relevant integrations, compare a candidate improvement to the baseline, and verify useful changes within the same scope and host resource limits. Review is advisory, not a veto or a new gate; no reviewer, score or minimum number of rounds is required. Explicit criteria and validation rules remain binding.
- Improvement does not reset retries, reopen completed steps or authorize repeating sends, payments, publications or migrations. Preserve the last valid result; do not repeat a review without changes or new evidence. Stop when no useful improvement is justified or limits require delivery.
- Report the result, evidence and limitations with concise progress updates, not private internal reasoning. Distinguish failed, not verified and not applicable checks; never fabricate compliance with a required check.

${executionModeBlock}

${toolInstruction}

Instance ID: ${params.instanceId}
Site ID: ${params.siteId}
Plan ID: ${params.plan.id}
${params.step.id ? `Step ID: ${params.step.id}\n` : ''}Step: ${params.step.order} — ${params.step.title}

${interpolateWorkflowText(params.relationPrompt || '', ctx)}

Instructions:
${instructions}

Expected output:
${expected || 'A concise factual result that satisfies the step.'}
${validationBlock}
${mcpHints ? `Suggested MCP actions:\n${mcpHints}\n` : ''}
Trigger payload:
${JSON.stringify(params.triggerPayload || {}, null, 2)}

Previous step outputs:
${JSON.stringify(params.previousOutputs || {}, null, 2)}

${sandboxInstruction}
${skillBlock}${params.retryContext || ''}

MANDATORY TERMINAL PROTOCOL:
- Your step is not complete until you call the direct \`plan_result\` tool.
- Submit factual structured data, evidence, and a pass/fail entry for every declared criterion and validation rule.
- If a required capability or external dependency is unavailable, call \`plan_result\` with status="failed" and a concrete error. Never report invented data.
- Plain text is not a completion signal and will be rejected by the runner.`;
}