export interface TextObservationOptions {
  signal?: AbortSignal;
  /** Omit for the platform credential; foreign credentials never establish platform health. */
  apiKey?: string;
  /** Reserved for separately scoped operations (e.g. continuation), not shared text health. */
  observationKey?: string;
}

function object(value: unknown): Record<PropertyKey, any> {
  return value && typeof value === 'object' ? value as Record<PropertyKey, any> : {};
}

function cancelled(error: unknown, signal?: AbortSignal): boolean {
  const failure = object(error);
  return signal?.aborted === true || ['AbortError', 'APIUserAbortError'].includes(failure.name);
}

function providerFailure(error: unknown): boolean {
  const failure = object(error);
  // Invalid caller options and local configuration are not provider availability evidence.
  if (typeof failure.status === 'number') {
    return [401, 402, 403, 408, 429].includes(failure.status) || failure.status >= 500;
  }
  return !['TypeError', 'RangeError', 'OpenRouterConfigurationError']
    .includes(failure.constructor?.name || failure.name);
}

function failedEnvelope(value: unknown): boolean {
  const result = object(value);
  return !!(result.error || result.body?.error) ||
    (Array.isArray(result.choices) && result.choices.some((choice: any) => choice?.finish_reason === 'error'));
}

const acceptedFinish = (reason: unknown) => ['stop', 'tool_calls', 'length'].includes(reason as string);
const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim();

function generatedMessage(message: any): boolean {
  if (!message || (message.role !== undefined && message.role !== 'assistant')) return false;
  return nonempty(message.content) || (Array.isArray(message.tool_calls) && message.tool_calls.some((call: any) =>
    nonempty(call?.id) && call?.type === 'function' && nonempty(call.function?.name)
    && typeof call.function?.arguments === 'string'));
}

/**
 * Observe only an existing real provider request, enclosing its entire admission retry.
 * Keep billing/validation/callbacks outside this callback. Never issues an extra request.
 * Receipts contain fixed labels only, not prompts, tools, errors, usage or credentials.
 */
export async function observeCompletedTextRequest<T>(
  model: string,
  request: () => PromiseLike<T>,
  options: TextObservationOptions = {},
): Promise<T> {
  const platform = options.apiKey === undefined || (!!process.env.OPENROUTER_API_KEY?.trim()
    && options.apiKey.trim() === process.env.OPENROUTER_API_KEY.trim());
  if (!platform) return await request();
  const startedAt = Date.now();
  let recorded = false;
  const observe = async (status: 'up' | 'down') => {
    if (recorded || options.signal?.aborted) return;
    recorded = true;
    try {
      // Lazy loading also keeps configuration-only paths free of database initialization.
      const { recordTelemetry } = await import('./telemetry');
      const { getTextObservationKey } = await import('./handlers/ai/passive-probes');
      await recordTelemetry(options.observationKey ?? getTextObservationKey(model), status,
        status === 'up' ? 'Text request completed with generated output' : 'Text provider request failed',
        Math.max(0, Date.now() - startedAt));
    } catch { /* Evidence persistence must never alter the provider result. */ }
  };

  let result: T;
  try { result = await request(); }
  catch (error) {
    if (!cancelled(error, options.signal) && providerFailure(error)) await observe('down');
    throw error;
  }
  const response = object(result);
  if (typeof response[Symbol.asyncIterator] !== 'function') {
    if (!options.signal?.aborted) {
      if (failedEnvelope(response)) await observe('down');
      else if (Array.isArray(response.choices) && response.choices.some((choice: any) =>
        acceptedFinish(choice?.finish_reason) && generatedMessage(choice.message))) await observe('up');
      // Content filtering is not a provider outage; malformed/empty output is not success.
      else if (!Array.isArray(response.choices) || !response.choices.some((choice: any) =>
        choice?.finish_reason === 'content_filter')) await observe('down');
    }
    return result;
  }

  const source = result as T & AsyncIterable<unknown>;
  const isCancelled = () => options.signal?.aborted || response.controller?.signal?.aborted;
  const iterate = async function* () {
    let generated = false;
    let finished = false;
    let filtered = false;
    // Boolean-only fragment state: never retain streamed content or tool arguments.
    const tools = new Map<string | number, { id: boolean; name: boolean; arguments: boolean }>();
    try {
      for await (const chunk of source) {
        const value = object(chunk);
        if (failedEnvelope(value) && !isCancelled()) await observe('down');
        for (const choice of Array.isArray(value.choices) ? value.choices : []) {
          finished ||= acceptedFinish(choice?.finish_reason);
          filtered ||= choice?.finish_reason === 'content_filter';
          const delta = choice?.delta;
          if (delta?.role !== undefined && delta.role !== 'assistant') continue;
          generated ||= nonempty(delta?.content);
          for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
            const key = `${choice.index ?? 0}:${call?.index ?? 0}`;
            const state = tools.get(key) ?? { id: false, name: false, arguments: false };
            state.id ||= nonempty(call?.id);
            state.name ||= nonempty(call?.function?.name);
            state.arguments ||= typeof call?.function?.arguments === 'string';
            tools.set(key, state);
            generated ||= state.id && state.name && state.arguments;
          }
        }
        yield chunk; // Preserve the exact chunk, including generation/usage/reasoning evidence.
      }
    } catch (error) {
      // SDK iterators abort their controller in finally on provider failures too.
      // A thrown source error (including invalid SSE JSON) is distinct from a user
      // abort, which the SDK returns normally or exposes as AbortError.
      if (!cancelled(error, options.signal)) await observe('down');
      throw error;
    }
    // return()/break()/caller callback exceptions skip this path, unlike normal exhaustion.
    if (!isCancelled() && !filtered) await observe(generated && finished ? 'up' : 'down');
  };
  return new Proxy(source, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return iterate;
      const value = Reflect.get(target, property, target);
      // SDK methods may use private fields; bind to the original object, not the Proxy.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}