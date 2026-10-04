import { createOpenRouterClient, isOpenRouterReasoningModel, resolveOpenRouterModel } from '@/lib/services/ai/openrouter';

export type VisualCriticResponseFormat = 'json_schema' | 'json_object';

export interface VisualCriticCompletionInput {
  model: string;
  siteId?: string;
  system: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
  >;
  signal: AbortSignal;
  maxOutputTokens?: number;
}

export interface VisualCriticCompletion {
  text: string;
  model: string;
  finishReason?: string;
  refusal?: string;
  responseFormat: VisualCriticResponseFormat;
  usage?: { cost?: number; [key: string]: unknown };
}

const VISUAL_CRITIC_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'visual_critic_verdict',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['pass', 'summary', 'defects'],
      properties: {
        pass: { type: 'boolean' },
        summary: { type: 'string', maxLength: 400 },
        defects: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'category',
              'severity',
              'route',
              'viewport',
              'description',
              'fix_hint',
            ],
            properties: {
              category: {
                type: 'string',
                enum: [
                  'hierarchy',
                  'spacing',
                  'typography',
                  'color_contrast',
                  'responsive',
                  'copy',
                  'state_missing',
                  'broken_visual',
                ],
              },
              severity: {
                type: 'string',
                enum: ['blocker', 'major', 'minor'],
              },
              route: { type: 'string', minLength: 1 },
              viewport: { type: 'string', minLength: 1 },
              description: { type: 'string', maxLength: 400 },
              fix_hint: { type: ['string', 'null'], maxLength: 400 },
            },
          },
        },
      },
    },
  },
};

function isStructuredOutputCompatibilityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; message?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : 0;
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);
  return (status === 400 || status === 422) && /response.?format|json.?schema|structured output/i.test(message);
}

export async function requestVisualCriticCompletion(
  input: VisualCriticCompletionInput,
): Promise<VisualCriticCompletion> {
  const client = createOpenRouterClient();
  const model = resolveOpenRouterModel(input.model);
  const reasoningModel = isOpenRouterReasoningModel(model);
  const tokenLimit = { max_tokens: input.maxOutputTokens ?? (reasoningModel ? 8_192 : 1_200) };
  const createCompletion = (
    responseFormat:
      | typeof VISUAL_CRITIC_RESPONSE_FORMAT
      | { type: 'json_object' },
  ) => client.chat.completions.create(
    {
      model,
      ...(input.siteId ? { user: input.siteId } : {}),
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.content as any },
      ],
      ...(reasoningModel ? {} : { temperature: 0.1 }),
      response_format: responseFormat,
      ...tokenLimit,
    },
    { signal: input.signal },
  );
  let responseFormat: VisualCriticCompletion['responseFormat'] = 'json_schema';
  let response;
  try {
    response = await createCompletion(VISUAL_CRITIC_RESPONSE_FORMAT);
  } catch (error: unknown) {
    if (!isStructuredOutputCompatibilityError(error)) throw error;
    responseFormat = 'json_object';
    response = await createCompletion({ type: 'json_object' });
  }
  const choice = response.choices[0];
  const message = choice?.message as
    | { content?: string | null; refusal?: string | null }
    | undefined;
  return {
    text: message?.content || '',
    model: response.model || model,
    finishReason: choice?.finish_reason || undefined,
    refusal: message?.refusal || undefined,
    responseFormat,
    ...(response.usage ? { usage: { ...response.usage } } : {}),
  };
}
