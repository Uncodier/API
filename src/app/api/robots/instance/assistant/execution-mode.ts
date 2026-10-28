/** Workflow-safe intent only. A mode never grants tool access or execution ownership. */
export type AssistantExecutionMode = 'direct' | 'harness';

export function isAssistantExecutionMode(value: unknown): value is AssistantExecutionMode {
  return value === 'direct' || value === 'harness';
}

/** Preserve the existing UI's explicit plan action during the mode rollout. */
export function resolveAssistantRequestMode(mode: AssistantExecutionMode | undefined, systemPrompt?: string): AssistantExecutionMode {
  return mode ?? (systemPrompt?.trim().toLowerCase() === 'plan' ? 'harness' : 'direct');
}

export const DIRECT_EXECUTION_INSTRUCTION = `DIRECT ASSISTANT EXECUTION:
Resolve the current user request with the authorized tools actually available. A linked requirement is context, not an instruction to start its execution cycle.
Ask a focused question before substantive work when essential information is clearly missing and cannot responsibly be obtained from the available context. Otherwise plan proportionally, act, inspect results and correct useful issues within the authorized scope.
You may discuss or prepare a plan without executing it. The presence of a pending plan does not authorize its execution. Do not claim a plan, requirement or sandbox started merely because a record exists or was updated.
Preserve completed work and report facts, limitations and remaining work. Use the authorized requirement command path for explicit managed-work changes; never create a competing executor or bypass a pause, budget, permission or uncertain external effect.
Only use capabilities that are actually provided. No repository, sandbox, skill lookup or plan is a prerequisite for a request that does not need it.`;