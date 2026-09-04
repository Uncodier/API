import type { DigestFileEntry } from '@/lib/services/docs-cycle-digest';
import { formatDigestForPrompt } from '@/lib/services/docs-cycle-digest';

export interface CycleWrapUpPromptInput {
  title: string;
  requirementId: string;
  instructions: string | null;
  historyPromptText: string;
  historyMode: 'full' | 'windowed' | 'empty';
  digestFiles: DigestFileEntry[] | null;
  planCompleted: boolean;
  /** Unstarted / in-progress plan steps still scheduled after this cycle. */
  pendingPlanSteps?: number;
  previewUrl?: string | null;
  repoUrl?: string | null;
}

export function countPendingPlanSteps(steps: Array<{ status?: string } | null> | null | undefined): number {
  if (!Array.isArray(steps)) return 0;
  return steps.filter((s) => s?.status === 'pending' || s?.status === 'in_progress').length;
}

/** Wrap-up must not ask for permission while later plan steps are still queued. */
export function shouldSkipWrapUpForPendingSteps(opts: {
  planCompleted: boolean;
  pendingPlanSteps?: number;
}): boolean {
  return !opts.planCompleted && (opts.pendingPlanSteps ?? 0) > 0;
}

/**
 * Build the wrap-up system prompt. Pure helper for tests + the cron step.
 */
export function buildCycleWrapUpSystemPrompt(input: CycleWrapUpPromptInput): string {
  const digestText = formatDigestForPrompt(input.digestFiles ?? []);
  const pending = input.pendingPlanSteps ?? 0;
  const continuePlan = !input.planCompleted && pending > 0;
  const verdictBlock = continuePlan
    ? `3. VERDICT: Plan steps remain (${pending}). Do NOT ask the user for permission and do NOT use stage='on-review'. Call \`requirement_status\` with stage='in-progress' and a short progress summary.`
    : `3. VERDICT CHOICE: You must decide between:
   - DELIVERED: If the task seems addressed, explain what is done and answer the client clearly in your final response prose. Optionally call \`requirement_status\` with stage='on-review' when appropriate.
   - NEEDS USER ITERATION: If something critical is missing, ambiguous, or requires human approval, you MUST explicitly ask the user for permission to run another iteration in your final response prose. Also call \`requirement_status\` with a clear waiting message (e.g. stage='on-review' or 'in-progress').`;

  return `You are a cycle evaluation agent wrapping up a delivery cycle for a requirement.

ROLE & TASK:
You must evaluate the work completed in this cycle against the original instructions and user requests.
You will write a client-facing answer summarizing what was done and stating any concrete facts found in the deliverables.

LANGUAGE:
- Write the final client-facing response in the SAME language as the ORIGINAL INSTRUCTIONS and/or the latest user messages (e.g. Spanish if they wrote in Spanish).
- Tool arguments and internal field names stay in English when required by schemas.

AVAILABLE TOOLS:
- \`requirement_status\`: Report the current stage ('in-progress', 'on-review', etc.) and a short client-facing message.

HARD RULES:
1. INFERENCE ONLY: You MUST infer facts ONLY from the Docs Digest below. If the digest contains a quote (e.g. price, timeline), state it clearly. Do NOT invent numbers, features, or facts.
2. FIDELITY: Respect the ORIGINAL instructions and any LATEST change requests from the user history.
${verdictBlock}
4. When you are done, simply finish your turn. Your final prose response will be shown to the client. Keep it concise (5-15 lines).

=== REQUIREMENT INFO ===
Title: ${input.title}
ID: ${input.requirementId}
Plan Completed this cycle: ${input.planCompleted}
Pending plan steps remaining: ${input.pendingPlanSteps ?? 0}
Preview URL: ${input.previewUrl || 'Not available'}
Repo URL: ${input.repoUrl || 'Not available'}
User history mode: ${input.historyMode}

=== ORIGINAL INSTRUCTIONS ===
${input.instructions || 'No original instructions provided.'}

${input.historyPromptText}

${digestText}
`;
}

/** Skip wrap-up when there is nothing useful to evaluate. */
export function shouldRunCycleWrapUp(opts: {
  hasDigest: boolean;
  userMessageCount: number;
}): boolean {
  return opts.hasDigest || opts.userMessageCount > 0;
}
