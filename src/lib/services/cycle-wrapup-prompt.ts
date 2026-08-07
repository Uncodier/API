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
  previewUrl?: string | null;
  repoUrl?: string | null;
}

/**
 * Build the wrap-up system prompt. Pure helper for tests + the cron step.
 */
export function buildCycleWrapUpSystemPrompt(input: CycleWrapUpPromptInput): string {
  const digestText = formatDigestForPrompt(input.digestFiles ?? []);

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
3. VERDICT CHOICE: You must decide between:
   - DELIVERED: If the task seems addressed, explain what is done and answer the client clearly in your final response prose. Optionally call \`requirement_status\` with stage='on-review' when appropriate.
   - NEEDS USER ITERATION: If something critical is missing, ambiguous, or requires human approval, you MUST explicitly ask the user for permission to run another iteration in your final response prose. Also call \`requirement_status\` with a clear waiting message (e.g. stage='on-review' or 'in-progress').
4. When you are done, simply finish your turn. Your final prose response will be shown to the client. Keep it concise (5-15 lines).

=== REQUIREMENT INFO ===
Title: ${input.title}
ID: ${input.requirementId}
Plan Completed this cycle: ${input.planCompleted}
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
