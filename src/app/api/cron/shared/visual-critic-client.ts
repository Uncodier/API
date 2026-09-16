import OpenAI from 'openai';
import { GoogleAuth } from 'google-auth-library';

type VisualProvider = 'gemini' | 'openai' | 'azure' | 'xai';

export interface VisualCriticCompletionInput {
  model: string;
  system: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
  >;
  signal: AbortSignal;
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
): Promise<{ text: string; model: string }> {
  const provider = resolveProvider();
  const client = createVisualClient(provider, input.model);
  const reasoningModel = /^(?:o[134]|gpt-5)/i.test(input.model);
  const tokenLimit = reasoningModel
    ? { max_completion_tokens: 1_200 }
    : { max_tokens: 1_200 };
  const response = await client.chat.completions.create(
    {
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.content as any },
      ],
      ...(reasoningModel ? {} : { temperature: 0.1 }),
      ...tokenLimit,
    },
    { signal: input.signal },
  );
  return {
    text: response.choices[0]?.message?.content || '',
    model: response.model || input.model,
  };
}
