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
}): string {
  const skillName = params.step.skill || 'makinari-rol-workflow-step';
  const matched = SkillsService.getSkillBySlugOrName(skillName);
  const skillBlock = matched
    ? `\n\n--- SKILL: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`
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
    : `EXECUTION MODE: LIVE (real)
This is a real production run, not a test. Call tools via tools and apply real side effects when the step instructions require them (CRM writes, notifications, messages). Do NOT simulate, mock, skip tools, or treat this as a dry run.`;

  const toolInstruction = params.preResponseOnly
    ? 'Do not call business tools. Submit a factual structured plan_result using the message and context given.'
    : params.dryRun
    ? 'Use tools for reads. For writes/sends, describe the simulated outcome instead of executing them.'
    : 'For steps that match their incoming relation you MUST call tools to fulfill the step. Do not only describe what you would do and never fabricate tool results.';

  return `⚠️ WORKFLOW MODE: You are executing ONE predefined workflow step. Do NOT create or update instance_plan or requirements. Do NOT plan new work.

${executionModeBlock}

${toolInstruction}

Instance ID: ${params.instanceId}
Site ID: ${params.siteId}
Plan ID: ${params.plan.id}
Step: ${params.step.order} — ${params.step.title}

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