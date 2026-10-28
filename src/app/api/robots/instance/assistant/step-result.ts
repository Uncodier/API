import { z } from 'zod';

const schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), summary: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ status: z.literal('failed'), summary: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ status: z.literal('needs_input'), question: z.string().trim().min(1).max(4000) }).strict(),
]);
export type AssistantStepResult = z.infer<typeof schema>;

/** Host-owned terminal intent. No quality score, inferred recipe or external effects. */
export function createAssistantStepResult() {
  let result: AssistantStepResult | undefined;
  const tool = {
    name: 'plan_result',
    description: 'Report this assigned step honestly: completed with its delivered summary, failed with the actual limitation, or needs_input with an essential question. A question or intermediate prose never completes the step. This records intent; the host persists the result.',
    parameters: { type: 'object', properties: {
      status: { type: 'string', enum: ['completed', 'failed', 'needs_input'] },
      summary: { type: 'string', description: 'Required for completed/failed; omit for needs_input.' },
      question: { type: 'string', description: 'Required for needs_input; omit for completed/failed.' },
    }, required: ['status'], additionalProperties: false },
    execute: async (input: unknown) => {
      // The shared executor may attach narration; it is not part of the result.
      const args = input && typeof input === 'object' && !Array.isArray(input)
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'thought_process')) : input;
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { success: false, executed: false, error: {
        code: 'INVALID_STEP_RESULT', message: 'Provide status and either summary for completed/failed or question for needs_input.', effectStarted: false,
      } };
      if (result) return { success: false, executed: false, error: {
        code: 'STEP_RESULT_ALREADY_REPORTED', message: 'A result for this turn was already reported.', effectStarted: false,
      } };
      result = parsed.data;
      return { success: true, accepted: true, status: result.status };
    },
  };
  return { tool, getResult: () => result ? { ...result } : undefined };
}