import OpenAI from 'openai';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_CHAT_MODEL = 'openai/gpt-6.1-sol';
export const DEFAULT_OPENROUTER_TTS_MODEL = 'microsoft/mai-voice-2.1';
export const DEFAULT_OPENROUTER_TTS_VOICE = 'es-MX-Valeria:MAI-Voice-2.1';

export function getOpenRouterTtsModel(env: NodeJS.Dict<string> = process.env): string {
  return env.OPENROUTER_TTS_MODEL?.trim() || DEFAULT_OPENROUTER_TTS_MODEL;
}

export function getOpenRouterTtsVoice(model: string, env: NodeJS.Dict<string> = process.env): string | undefined {
  return env.OPENROUTER_TTS_VOICE?.trim()
    || (model === DEFAULT_OPENROUTER_TTS_MODEL ? DEFAULT_OPENROUTER_TTS_VOICE : undefined);
}

/** Keep the gateway separate from the model vendor. Qualified IDs are never rewritten. */
export function resolveOpenRouterModel(model?: string, family = 'openai'): string {
  const value = model?.trim();
  if (!value) return getOpenRouterChatModel();
  if (value.includes('/')) return value;
  const vendor = value.startsWith('gemini') ? 'google'
    : value.startsWith('claude') ? 'anthropic'
      : value.startsWith('grok') ? 'x-ai'
        : /^(gpt-|o\d|text-embedding-|tts-|whisper-|sora-)/.test(value) ? 'openai'
          : family === 'gemini' ? 'google'
            : family === 'openrouter' || family === 'azure' ? 'openai' : family;
  return `${vendor}/${value}`;
}

export function getOpenRouterChatModel(env: NodeJS.Dict<string> = process.env): string {
  const configured = env.OPENROUTER_CHAT_MODEL?.trim();
  return configured ? resolveOpenRouterModel(configured) : DEFAULT_OPENROUTER_CHAT_MODEL;
}

export function isOpenRouterReasoningModel(model: string): boolean {
  return /^openai\/(gpt-[5-9](?:[.-]|$)|o[1-9](?:[.-]|$))/.test(model);
}

export interface OpenRouterClientOptions {
  /** Server-resolved credential only. An explicitly empty credential fails closed. */
  apiKey?: string;
  env?: NodeJS.Dict<string>;
  timeout?: number;
  maxRetries?: number;
}

/** No shared singleton: future workspace credentials cannot bleed into another request. */
export function createOpenRouterClient(options: OpenRouterClientOptions = {}): OpenAI {
  if (typeof window !== 'undefined') {
    throw new Error('OpenRouter credentials must only be used on the server');
  }
  const env = options.env ?? process.env;
  const apiKey = (options.apiKey !== undefined ? options.apiKey : env.OPENROUTER_API_KEY)?.trim();
  if (!apiKey) throw new Error('OpenRouter is not configured: set OPENROUTER_API_KEY');
  const headers: Record<string, string> = {};
  if (env.OPENROUTER_APP_URL?.trim()) headers['HTTP-Referer'] = env.OPENROUTER_APP_URL.trim();
  if (env.OPENROUTER_APP_NAME?.trim()) headers['X-OpenRouter-Title'] = env.OPENROUTER_APP_NAME.trim();
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: headers,
    timeout: options.timeout ?? 240_000,
    // Avoid duplicate billable generations. Callers can opt into same-account retries.
    maxRetries: options.maxRetries ?? 0,
  });
}