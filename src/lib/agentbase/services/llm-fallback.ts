/**
 * Shared LLM error classifiers and non-stream fallback (gpt-4o, then AI Gateway).
 */

export function isRateLimitError(error: any): boolean {
  return Boolean(
    error?.status === 429 ||
      error?.body?.error?.message?.includes('exceeded token rate limit') ||
      error?.body?.error?.message?.includes('AIServices S0 pricing tier') ||
      error?.body?.error?.param?.error?.includes('exceeded token rate limit') ||
      error?.body?.error?.param?.error?.includes('AIServices S0 pricing tier') ||
      error?.message?.includes('rate limit') ||
      error?.message?.includes('exceeded token rate limit') ||
      error?.message?.includes('AIServices S0 pricing tier')
  );
}

export function isTimeoutOrConnectError(error: any): boolean {
  return Boolean(
    error?.message?.includes('timeout') ||
      error?.message?.includes('Connect Timeout') ||
      error?.message?.includes('fetch failed') ||
      error?.message?.includes('Could not instantiate the Portkey client') ||
      error?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      error?.code === 'timeout'
  );
}

export function throwIfRateLimitedBody(response: any): void {
  if (!response || typeof response !== 'object' || !response.body?.error) return;
  const errorBody = response.body;
  if (
    errorBody.status === 429 ||
    errorBody.body?.error?.message?.includes('exceeded token rate limit') ||
    errorBody.body?.error?.message?.includes('AIServices S0 pricing tier')
  ) {
    throw {
      status: 429,
      body: errorBody.body,
      message: errorBody.body?.error?.message || 'Rate limit exceeded',
    };
  }
}

export function buildGpt4oFallbackModelOptions(modelOptions: any): any {
  const fallbackModelOptions: any = {
    ...modelOptions,
    model: 'gpt-4o',
    stream: false,
  };
  if (modelOptions.max_completion_tokens != null) {
    fallbackModelOptions.max_tokens = modelOptions.max_completion_tokens;
  } else if (modelOptions.max_tokens != null) {
    fallbackModelOptions.max_tokens = modelOptions.max_tokens;
  }
  delete fallbackModelOptions.max_completion_tokens;
  delete fallbackModelOptions.reasoning;
  return fallbackModelOptions;
}

export function formatOpenAiNonStreamResponse(
  response: any,
  provider: string,
  model: string,
  fallbackFrom?: string
): any {
  const content = response?.choices?.[0]?.message?.content || '';
  const usage = response?.usage
    ? {
        ...response.usage,
        total_tokens:
          response.usage.total_tokens ||
          (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0),
      }
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    content,
    usage,
    modelInfo: {
      model,
      provider,
      ...(fallbackFrom ? { fallbackFrom } : {}),
    },
  };
}

type GatewayLike = {
  isAvailable: () => boolean;
  callAgent: (messages: any[], options: any) => Promise<any>;
};

export async function tryNonStreamModelFallback(params: {
  error: any;
  stream?: boolean;
  provider: string;
  usedModel: string;
  messages: any[];
  modelOptions: any;
  customHeaders: Record<string, string>;
  portkey: any;
  aiGateway: GatewayLike;
}): Promise<any | null> {
  const { error, stream, provider, usedModel, messages, modelOptions, customHeaders, portkey, aiGateway } = params;
  if (stream === true) return null;
  if (provider !== 'openai') return null;
  if (!isRateLimitError(error) && !isTimeoutOrConnectError(error)) return null;

  try {
    console.warn(`[PortkeyConnector] Non-stream ${usedModel} failed (${error?.message || error}), falling back to gpt-4o`);
    const fallbackModelOptions = buildGpt4oFallbackModelOptions(modelOptions);
    const fallbackResponse = await portkey.chat.completions.create(
      { messages, ...fallbackModelOptions, stream: false },
      { headers: customHeaders }
    );
    throwIfRateLimitedBody(fallbackResponse);
    console.log('[PortkeyConnector] gpt-4o non-stream fallback succeeded');
    return formatOpenAiNonStreamResponse(fallbackResponse, provider, 'gpt-4o', usedModel);
  } catch (gpt4oError: any) {
    console.error('[PortkeyConnector] gpt-4o non-stream fallback failed:', gpt4oError?.message || gpt4oError);
  }

  if (!aiGateway.isAvailable()) {
    return null;
  }

  try {
    console.warn('[PortkeyConnector] Trying AI Gateway non-stream fallback');
    const gatewayResponse = await aiGateway.callAgent(messages, {
      model: modelOptions.model,
      maxTokens: modelOptions.max_tokens || modelOptions.max_completion_tokens,
      temperature: modelOptions.temperature,
      topP: modelOptions.top_p,
      stream: false,
    });
    console.log('[PortkeyConnector] AI Gateway non-stream fallback succeeded');
    return gatewayResponse;
  } catch (gatewayError: any) {
    console.error('[PortkeyConnector] AI Gateway non-stream fallback failed:', gatewayError?.message || gatewayError);
    return null;
  }
}

export async function tryStreamingGpt55Fallback(params: {
  error: any;
  stream?: boolean;
  provider: string;
  messages: any[];
  modelOptions: any;
  customHeaders: Record<string, string>;
  portkey: any;
}): Promise<any | null> {
  const { error, stream, provider, messages, modelOptions, customHeaders, portkey } = params;
  const isStreamingError =
    stream === true &&
    (error?.message?.includes('Stream hung after role-only first chunk') ||
      error?.message?.includes('Chunk timeout') ||
      error?.message?.includes('timeout'));
  if (!isStreamingError || provider !== 'openai' || modelOptions.model !== 'gpt-5.5') {
    return null;
  }

  console.warn('[PortkeyConnector] GPT-5.5 streaming failed, trying fallback to GPT-4o...');
  try {
    const fallbackModelOptions = buildGpt4oFallbackModelOptions({ ...modelOptions, stream: true });
    const fallbackResponse = await portkey.chat.completions.create(
      {
        messages,
        ...fallbackModelOptions,
        stream: true,
        stream_options: { include_usage: true },
      },
      { headers: customHeaders }
    );
    throwIfRateLimitedBody(fallbackResponse);
    console.log('[PortkeyConnector] GPT-4o streaming fallback succeeded');
    return {
      stream: fallbackResponse,
      isStream: true,
      modelInfo: { model: 'gpt-4o', provider, fallbackFrom: 'gpt-5.5' },
    };
  } catch (fallbackError: any) {
    console.error('[PortkeyConnector] GPT-4o streaming fallback failed:', fallbackError?.message || fallbackError);
  }

  try {
    console.warn('[PortkeyConnector] Trying non-streaming fallback for original model...');
    const nonStreamingResponse = await portkey.chat.completions.create(
      { messages, ...modelOptions, stream: false },
      { headers: customHeaders }
    );
    throwIfRateLimitedBody(nonStreamingResponse);
    console.log('[PortkeyConnector] Non-streaming fallback succeeded');
    return {
      stream: nonStreamingResponse,
      isStream: false,
      modelInfo: {
        model: modelOptions.model,
        provider,
        fallbackFrom: 'streaming',
        fallbackType: 'non-streaming',
      },
    };
  } catch (nonStreamingError: any) {
    console.error('[PortkeyConnector] Non-streaming fallback also failed:', nonStreamingError?.message || nonStreamingError);
    return null;
  }
}
