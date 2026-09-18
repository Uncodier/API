import OpenAI from 'openai';
import { GoogleAuth } from 'google-auth-library';

type VisualProvider = 'gemini' | 'openai' | 'azure' | 'xai';
export type VisualCriticResponseFormat = 'json_schema' | 'json_object';

export interface VisualCriticCompletionInput {
  model: string;
  system: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
  >;
  signal: AbortSignal;
}

export interface VisualCriticCompletion {
  text: string;
  model: string;
  finishReason?: string;
  refusal?: string;
  responseFormat: VisualCriticResponseFormat;
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
  const message = typeof candidate.message === 'string'
    ? candidate.message
    : String(error);
  return (
    (status === 400 || status === 422) &&
    /response.?format|json.?schema|structured output/i.test(message)
  );
}

function resolveProvider(env: NodeJS.ProcessEnv = process.env): VisualProvider {
  const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  if (
    provider === 'gemini' ||
    provider === 'openai' ||
    provider === 'azure' ||
    provider === 'xai'
  ) {
    return provider;
  }
  return 'gemini';
}

function createVisualClient(
  provider: VisualProvider,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenAI {
  if (provider === 'azure') {
    const apiKey = env.MICROSOFT_AZURE_OPENAI_API_KEY;
    const endpoint = env.MICROSOFT_AZURE_OPENAI_ENDPOINT;
    const deployment =
      env.AI_VISUAL_AZURE_DEPLOYMENT ||
      env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT ||
      model;
    const apiVersion =
      env.MICROSOFT_AZURE_OPENAI_API_VERSION || '2024-08-01-preview';
    if (!apiKey || !endpoint || !deployment) {
      throw new Error('Azure visual critic credentials are incomplete');
    }
    return new OpenAI({
      apiKey,
      baseURL: `${endpoint.replace(/\/+$/, '')}/openai/deployments/${deployment}`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': apiKey },
    });
  }

  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
    return new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });
  }

  if (provider === 'xai') {
    if (env.XAI_API_KEY) {
      return new OpenAI({
        apiKey: env.XAI_API_KEY,
        baseURL: env.XAI_BASE_URL || 'https://api.x.ai/v1',
      });
    }
    if (!env.GOOGLE_CLOUD_PROJECT_ID) {
      throw new Error(
        'XAI_API_KEY or GOOGLE_CLOUD_PROJECT_ID is required for the visual critic',
      );
    }
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    return new OpenAI({
      apiKey: 'vertex-managed-token',
      baseURL:
        `https://aiplatform.googleapis.com/v1/projects/` +
        `${env.GOOGLE_CLOUD_PROJECT_ID}/locations/global/endpoints/openapi/`,
      fetch: async (url, init) => {
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        return fetch(url, {
          ...init,
          headers: {
            ...init?.headers,
            Authorization: `Bearer ${token.token}`,
          },
        });
      },
    });
  }

  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing');
  return new OpenAI({
    apiKey: env.GEMINI_API_KEY,
    baseURL:
      env.GEMINI_OPENAI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai/',
  });
}

export async function requestVisualCriticCompletion(
  input: VisualCriticCompletionInput,
): Promise<VisualCriticCompletion> {
  const provider = resolveProvider();
  const client = createVisualClient(provider, input.model);
  const reasoningModel = /^(?:o[134]|gpt-5)/i.test(input.model);
  const tokenLimit = reasoningModel
    ? { max_completion_tokens: 1_200 }
    : { max_tokens: 1_200 };
  const createCompletion = (
    responseFormat:
      | typeof VISUAL_CRITIC_RESPONSE_FORMAT
      | { type: 'json_object' },
  ) => client.chat.completions.create(
    {
      model: input.model,
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
    model: response.model || input.model,
    finishReason: choice?.finish_reason || undefined,
    refusal: message?.refusal || undefined,
    responseFormat,
  };
}
