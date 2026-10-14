/** Retry only request admission, never stream consumption, callbacks or tools. */
export const OPENROUTER_CHAT_LIMITS = Object.freeze({
  outputTokens: 8_192,
  singleTurnOutputTokens: 4_096,
  maxOutputTokens: 32_768,
  maxRetries: 2,
  retryWaitBudgetMs: 20_000,
});

export function resolveChatOutputTokens(
  requested?: number,
  singleTurn = false,
  env: NodeJS.Dict<string> = process.env,
): number {
  const fallback = singleTurn ? OPENROUTER_CHAT_LIMITS.singleTurnOutputTokens : OPENROUTER_CHAT_LIMITS.outputTokens;
  const configured = env.OPENROUTER_CHAT_MAX_OUTPUT_TOKENS;
  const value = requested ?? (configured && /^\d+$/.test(configured) ? Number(configured) : fallback);
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, OPENROUTER_CHAT_LIMITS.maxOutputTokens) : fallback;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function retryAfterMs(error: Record<string, any>, now: number): number | undefined {
  const headers = error.headers;
  const value = typeof headers?.get === 'function' ? headers.get('retry-after')
    : headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof value !== 'string' || !value.trim()) return;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : Infinity;
}

/** Safe machine-readable facts only; provider text/headers may contain secrets. */
export function describeOpenRouterFailure(error: unknown): {
  status: number; category: 'funding' | 'authentication' | 'request' | 'availability';
} | undefined {
  const status = object(error).status;
  if (!Number.isInteger(status) || status < 400 || status > 599) return;
  return { status, category: status === 402 ? 'funding' : status === 401 || status === 403
    ? 'authentication' : status === 408 || status === 429 || status >= 500 ? 'availability' : 'request' };
}

/** A positive affordability hint may lower output only; it never establishes funding. */
function affordableOutputTokens(error: Record<string, any>, current: number): number | undefined {
  const body = object(error.error);
  const text = typeof body.message === 'string' ? body.message : error.message;
  if (typeof text !== 'string') return;
  const match = text.match(/can only afford\s+(\d+)\b/i);
  const affordable = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(affordable) || affordable <= 0 || affordable >= current) return;
  // Leave headroom for provider accounting; avoid an unusably tiny generation.
  const reduced = Math.floor(affordable * .9);
  return reduced >= 256 && reduced < current ? reduced : undefined;
}

export async function requestOpenRouterChat<T>(
  request: Record<string, any>,
  create: (request: Record<string, any>) => Promise<T>,
  runtime: { sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number } = {},
): Promise<T> {
  const sleep = runtime.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = runtime.now ?? Date.now;
  const random = runtime.random ?? Math.random;
  const deadline = now() + OPENROUTER_CHAT_LIMITS.retryWaitBudgetMs;
  let outputTokens = resolveChatOutputTokens(request.max_tokens);
  let reducedForFunding = false;
  for (let attempt = 0; ; attempt++) {
    try {
      // Fresh top-level payload: a retry cannot mutate a prior SDK request.
      return await create({ ...request, max_tokens: outputTokens });
    } catch (error) {
      if (attempt >= OPENROUTER_CHAT_LIMITS.maxRetries) throw error;
      const failure = object(error);
      const status = failure.status;
      // Explicit generation identity or usage means possible acceptance, even
      // on a non-2xx response. Do not hide it with another generation.
      const body = object(failure.error);
      const metadata = object(body.metadata);
      if (failure.generationId || body.generation_id || metadata.generation_id || failure.usage || body.usage) throw error;
      const retryAfter = retryAfterMs(failure, now());
      const inFlightBudget = status === 402 &&
        metadata.limit_source === 'openrouter_in_flight_budget';
      const reduced = status === 402 && !inFlightBudget && !reducedForFunding
        ? affordableOutputTokens(failure, outputTokens) : undefined;
      // DNS/refused connection proves no upstream generation; a timeout/reset does not.
      const connectionCode = object(failure.cause).code;
      const beforeConnection = status === undefined && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(connectionCode);
      if (reduced !== undefined) {
        outputTokens = reduced;
        reducedForFunding = true;
      } else if (!(beforeConnection || [408, 429, 500, 502, 503, 504].includes(status) ||
          (inFlightBudget && retryAfter !== undefined))) {
        throw error;
      }
      const delayMs = Math.max(500 * 2 ** attempt + Math.floor(random() * 250), retryAfter ?? 0);
      // Never shorten Retry-After to fit the local deadline. The caller can defer.
      if (!Number.isFinite(delayMs) || now() + delayMs > deadline) throw error;
      console.warn('[OpenRouter] Retrying chat admission', {
        attempt: attempt + 2, status: typeof status === 'number' ? status : undefined,
        delayMs, maxOutputTokens: outputTokens,
      });
      await sleep(delayMs);
    }
  }
}