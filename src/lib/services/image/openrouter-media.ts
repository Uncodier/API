import { OPENROUTER_BASE_URL } from '@/lib/services/ai/openrouter';
import { readResponseWithLimit } from '@/lib/security/limited-response';

import { MediaRequestError } from './media-request-error';
export { MediaRequestError } from './media-request-error';

export async function openRouterMediaRequest(
  path: string,
  options: { body?: unknown; timeout?: number; apiKey?: string; env?: NodeJS.Dict<string> } = {},
): Promise<Response> {
  const env = options.env ?? process.env;
  const key = (options.apiKey !== undefined ? options.apiKey : env.OPENROUTER_API_KEY)?.trim();
  if (!key) throw new MediaRequestError('OpenRouter is not configured: set OPENROUTER_API_KEY', 503);
  // Only application-constructed paths; never follow provider polling/download URLs.
  if (!/^\/(images|videos)(?:[/?]|$)/.test(path) || path.includes('..')) {
    throw new MediaRequestError('Invalid media API path', 400);
  }
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(env.OPENROUTER_APP_URL ? { 'HTTP-Referer': env.OPENROUTER_APP_URL } : {}),
        ...(env.OPENROUTER_APP_NAME ? { 'X-OpenRouter-Title': env.OPENROUTER_APP_NAME } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeout ?? 20_000),
    });
    if (!response.ok) {
      throw new MediaRequestError(`OpenRouter media request failed (${response.status})`);
    }
    return response;
  } catch (error) {
    if (error instanceof MediaRequestError) throw error;
    throw new MediaRequestError('OpenRouter media request failed or timed out');
  }
}

export async function openRouterMediaJson<T>(
  path: string,
  options: Parameters<typeof openRouterMediaRequest>[1] = {},
  maxBytes = 5 * 1024 * 1024,
): Promise<T> {
  const response = await openRouterMediaRequest(path, options);
  try {
    return JSON.parse((await readResponseWithLimit(response, maxBytes)).toString('utf8')) as T;
  } catch {
    throw new MediaRequestError('OpenRouter returned an invalid media response');
  }
}