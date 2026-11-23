import type OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { createOpenRouterClient, resolveOpenRouterModel } from '@/lib/services/ai/openrouter';
import { requestOpenRouterChat } from '@/lib/services/ai/openrouter-chat-request';
import { observeCompletedTextRequest } from '@/lib/status/text-execution-observation';
import { isAzureInvalidImageError, sanitizeMessagesForAzureVisionImages } from '../azure-vision-message-sanitize';
import type { AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';
import type { ActOptions, AIProvider, AIAgentExecutorConfig, Message } from './types';
import { runBoundaryHook, runBoundaryBillingHook, settleCompletion, settleUncertainRequest } from './boundary';


/**
 * Log routing and status only. SDK error bodies, headers and prompt excerpts
 * can echo credentials and must not be included in application logs.
 */
function logChatCompletionFailure(
  err: unknown,
  ctx: {
    provider: AIProvider | string;
    stage: 'stream' | 'fallback' | 'non-stream';
    modelName?: string;
    messages?: unknown[];
    toolCount?: number;
  },
): void {
  const error = err as { status?: unknown; request_id?: unknown } | undefined;
  // Never log SDK error bodies/headers or prompt previews: gateways can echo
  // credentials, tool arguments or private context in their rejection details.
  console.error('[AI EXECUTOR] OpenRouter request failed', {
    provider: ctx.provider,
    stage: ctx.stage,
    model: ctx.modelName,
    messageCount: ctx.messages?.length,
    toolCount: ctx.toolCount,
    status: typeof error?.status === 'number' ? error.status : undefined,
  });
}

export abstract class ModelTransport {
  private client: OpenAI;
  protected model: string;
  protected provider: AIProvider;
  protected readonly siteId?: string;
  private readonly observationApiKey?: string;
  protected contextModelId: string | null = null;

  constructor(config?: AIAgentExecutorConfig | string) {
    // Back-compat: string arg is treated as an API key for the selected provider.
    if (typeof config === 'string') {
      config = { apiKey: config };
    }

    if (config?.apiKey !== undefined && config.provider && config.provider !== 'openrouter') {
      throw new Error('Legacy provider credentials are not accepted by OpenRouter. Use provider: openrouter with an OpenRouter API key.');
    }
    if (config?.endpoint || config?.deployment || config?.apiVersion ||
        (config?.provider === 'azure' && config.model && !config.model.includes('/') && !/^(gpt-|o\d)/.test(config.model))) {
      throw new Error('Azure deployment configuration cannot be migrated automatically. Select an OpenRouter catalog model ID.');
    }

    this.provider = 'openrouter';
    this.siteId = config?.siteId;
    this.observationApiKey = config?.apiKey;
    this.client = createOpenRouterClient({ apiKey: config?.apiKey });
    this.model = resolveOpenRouterModel(config?.model, config?.provider);

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [AI EXECUTOR] provider=${this.provider} model=${this.model}`);
  }

  /** Expose the resolved provider (useful for callers that log/route). */
  getProvider(): AIProvider {
    return this.provider;
  }

  /** Expose the resolved default model. */
  getModel(): string {
    return this.model;
  }

  /** Admit every actual provider attempt only after the host accepts its final payload. */
  private async createModelCompletion(request: Record<string, any>, boundary?: AssistantExecutionBoundary, system = '',
    beforeDispatch?: (request: Record<string, any>) => Promise<void>): Promise<any> {
    if (boundary) {
      await runBoundaryHook(async () => {
        boundary.signal?.throwIfAborted();
        await boundary.beforeModel({ system, messages: request.messages,
          tools: request.tools || [], maxOutputTokens: request.max_tokens });
        boundary.signal?.throwIfAborted();
      }, boundary.signal);
    }
    if (beforeDispatch) await beforeDispatch(request);
    return this.client.chat.completions.create(request as any,
      boundary?.signal ? { signal: boundary.signal } : undefined);
  }

  /**
   * Run streaming completion: iterate over chunks, accumulate message, call onStreamChunk.
   * Supports reasoning/thinking via delta.reasoning_content or delta.reasoning (o-series, etc).
   * Throttles DB updates to ~80ms to avoid excessive instance_log writes.
   */
  private async runStreamingCompletion(
    completionOptions: Record<string, any>,
    callbacks: {
      onStreamStart: () => Promise<string>;
      onStreamChunk: (
        logId: string,
        text: string,
        final?: boolean,
      ) => Promise<void>;
      onThinkingStreamStart?: () => Promise<string>;
      onThinkingStreamChunk?: (
        logId: string,
        text: string,
        final?: boolean,
      ) => Promise<void>;
      onReasoningTokensUsed?: (count: number) => Promise<void>;
    },
    billing: { siteId?: string; eventId: string },
    boundary?: AssistantExecutionBoundary,
    system = '',
  ): Promise<{
    message: any;
    generationId?: string;
    model?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    finish_reason?: string;
    streamingLogId?: string;
  }> {
    const opts = {
      ...completionOptions,
      stream: true,
      stream_options: { include_usage: true },
    };
    const stream = await observeCompletedTextRequest(completionOptions.model,
      () => requestOpenRouterChat(opts, request => this.createModelCompletion(request, boundary, system)),
      { apiKey: this.observationApiKey, signal: boundary?.signal }).catch(async err => {
      if (err?.name === 'RecoveryError') throw err;
      console.error(`[AI STREAM INIT ERROR][${this.provider}] Provider stream unavailable`);
      if (err.status) console.error(`   Status: ${err.status}`);
      await settleUncertainRequest(billing.siteId, billing.eventId, err, completionOptions.model);
      throw err;
    });

    // Everything after stream admission may have consumed a paid generation,
    // including transport errors and callbacks without identity/usage attached.
    try {
      let content = '';
      let generationId: string | undefined;
      let responseModel: string | undefined;
      let reasoningContent = '';
      const reasoningDetails: any[] = [];
      // `extra_content` carries Gemini 3's thought_signature
      // (`extra_content.google.thought_signature`). We MUST persist it verbatim
      // across the history or the next call 400s with "Function call is missing
      // a thought_signature". See:
      //   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
      //   https://github.com/openai/openai-openapi/issues/517
      const toolCallsAccum: Record<string | number, { id?: string; type: 'function'; function: { name?: string; arguments?: string }; extra_content?: any; insertedAt: number }> = {};
      let insertionCounter = 0;
      let finishReason: string | undefined;
      let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
      let streamingLogId: string | undefined;
      let thinkingLogId: string | undefined;
      const STREAM_THROTTLE_MS = 80;
      let lastEmitTime = 0;
      let lastThinkingEmitTime = 0;

      try {
        for await (const chunk of stream as unknown as AsyncIterable<any>) {
          if (chunk.id) generationId = chunk.id;
          if (chunk.model) responseModel = chunk.model;
          if (chunk.usage) {
            usage = chunk.usage;
          }
          if (chunk.error || chunk.choices?.[0]?.finish_reason === 'error') {
            // An SSE error belongs to an accepted generation, not request admission.
            throw new Error('OpenRouter stream failed after acceptance; reconcile before retrying.');
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const delta = choice.delta || {};

          // OpenRouter reasoning blocks carry encrypted state required for tool replay.
          // Merge streamed fragments by their index; never expose these as tool arguments.
          for (const detail of delta.reasoning_details || []) {
            const previous = detail.index !== undefined
              ? reasoningDetails.find(value => value.index === detail.index && value.type === detail.type)
              : undefined;
            if (!previous) reasoningDetails.push({ ...detail });
            else {
              const fragments = Object.fromEntries(['text', 'data', 'summary', 'signature']
                .filter(key => typeof detail[key] === 'string')
                .map(key => [key, (previous[key] || '') + detail[key]]));
              Object.assign(previous, detail, fragments);
            }
          }

          const reasoningDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
          if (reasoningDelta && callbacks.onThinkingStreamStart && callbacks.onThinkingStreamChunk) {
            reasoningContent += reasoningDelta;
            if (!thinkingLogId) {
              thinkingLogId = await callbacks.onThinkingStreamStart();
            }
            const now = Date.now();
            if (now - lastThinkingEmitTime >= STREAM_THROTTLE_MS && thinkingLogId) {
              lastThinkingEmitTime = now;
              await callbacks.onThinkingStreamChunk(thinkingLogId, reasoningContent);
            }
          }

          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            if (!streamingLogId) {
              streamingLogId = await callbacks.onStreamStart();
            }
            const now = Date.now();
            if (now - lastEmitTime >= STREAM_THROTTLE_MS && streamingLogId) {
              lastEmitTime = now;
              await callbacks.onStreamChunk(streamingLogId, content);
            }
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              // Gemini's OpenAI-compat layer often omits `index` on tool_call deltas.
              // Falling back to `?? 0` collapses unrelated tool calls into the same
              // slot and concatenates their `arguments` strings (e.g. `{...}{...}`),
              // which then explodes in JSON.parse downstream.
              // Use `tc.id` to disambiguate when available; only fall back to 0
              // when there is truly nothing else.
              let idx: number | string;
              if (typeof tc.index === 'number') {
                idx = tc.index;
              } else if (tc.id) {
                idx = `id:${tc.id}`;
              } else {
                // Reuse last seen slot if we have one with a name but no closing
                // (continuation chunk); otherwise start a new one.
                const keys = Object.keys(toolCallsAccum);
                idx = keys.length > 0 ? keys[keys.length - 1] : 0;
              }
              if (!toolCallsAccum[idx]) {
                toolCallsAccum[idx] = { type: 'function', function: {}, insertedAt: insertionCounter++ };
              }
              if (tc.id) toolCallsAccum[idx].id = tc.id;
              if (tc.function?.name) toolCallsAccum[idx].function!.name = tc.function.name;
              if (tc.function?.arguments) {
                toolCallsAccum[idx].function!.arguments = (toolCallsAccum[idx].function!.arguments || '') + (tc.function.arguments || '');
              }
              // Gemini 3: preserve vendor extras (thought_signature). Later
              // deltas may replace/extend the object — keep the most recent
              // complete value.
              if (tc.extra_content && typeof tc.extra_content === 'object') {
                toolCallsAccum[idx].extra_content = {
                  ...(toolCallsAccum[idx].extra_content || {}),
                  ...tc.extra_content,
                };
              }
            }
          }
        }

      } finally {
        // Settle before parsing tool arguments or any final callback, even on stream/callback failure.
        await settleCompletion(billing.siteId, billing.eventId, usage, generationId, responseModel || completionOptions.model);
      }

      if (streamingLogId && content) {
        await callbacks.onStreamChunk(streamingLogId, content, true);
      }
      if (thinkingLogId && reasoningContent && callbacks.onThinkingStreamChunk) {
        await callbacks.onThinkingStreamChunk(thinkingLogId, reasoningContent, true);
      }

      if (!thinkingLogId && callbacks.onReasoningTokensUsed && usage) {
        const u = usage as any;
        const reasoningTokens =
          u?.completion_tokens_details?.reasoning_tokens ??
          u?.output_tokens_details?.reasoning_tokens ??
          u?.reasoning_tokens ??
          0;
        if (reasoningTokens > 0) {
          await callbacks.onReasoningTokensUsed(reasoningTokens);
        }
      }

      const toolCallsArray = Object.values(toolCallsAccum)
        .sort((a, b) => a.insertedAt - b.insertedAt)
        .filter((tc) => tc.id && tc.function?.name);

      const message: any = {
        role: 'assistant',
        content: content || null,
        ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
      };
      if (toolCallsArray.length > 0) {
        message.tool_calls = toolCallsArray.map((tc) => {
          const out: any = {
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function!.name!, arguments: tc.function!.arguments || '{}' },
          };
          if (tc.extra_content) out.extra_content = tc.extra_content;
          return out;
        });
      }

      return { message, usage, generationId, model: responseModel, finish_reason: finishReason, streamingLogId };
    } catch (error: any) {
      if (error?.name === 'OpenRouterBillingError' || error?.name === 'RecoveryError') throw error;
      throw Object.assign(new Error('Inference interrupted after acceptance; reconciliation required'), { inferenceAccepted: true });
    }
  }

  /** Set acceptance before settlement or response parsing so a later failure can never trigger a replay. */
  protected async requestTurn(options: ActOptions, completionOptions: Record<string, any>, messages: Message[],
    modelName: string, toolCount: number, onAccepted: () => void) {
    const { system, schema, executionBoundary, stream: useStreaming, onStreamStart, onStreamChunk,
      onThinkingStreamStart, onThinkingStreamChunk, onReasoningTokensUsed } = options;
    const provider = this.provider;
    // Boundary turns use durable host receipts and strict redacted onStep logs.
    const useStreamingPath = !executionBoundary && useStreaming && onStreamStart && onStreamChunk && !schema;
    const useThinkingStream = useStreamingPath && onThinkingStreamStart && onThinkingStreamChunk;

    const optsForLog = { model: modelName, stream: Boolean(useStreamingPath), toolCount, messageCount: messages.length };
    if (!executionBoundary) console.log(`🔍 [DEBUG][${provider}] API Payload Options:`, JSON.stringify(optsForLog, null, 2));

    let response: { message: any; usage?: any; finish_reason?: string; generationId?: string; model?: string };
    const eventId = randomUUID();
    const billingSiteId = options.siteId || this.siteId;

    if (useStreamingPath) {
      try {
        const streamCallbacks: Parameters<typeof this.runStreamingCompletion>[1] = {
          onStreamStart: onStreamStart!,
          onStreamChunk: onStreamChunk!,
          onReasoningTokensUsed: onReasoningTokensUsed,
        };
        if (useThinkingStream) {
          streamCallbacks.onThinkingStreamStart = onThinkingStreamStart!;
          streamCallbacks.onThinkingStreamChunk = onThinkingStreamChunk!;
        }
        response = await this.runStreamingCompletion(
          completionOptions,
          streamCallbacks,
          { siteId: billingSiteId, eventId },
          executionBoundary,
          system || '',
        );
        onAccepted();
      } catch (streamError: any) {
        logChatCompletionFailure(streamError, {
          provider,
          stage: 'stream',
          modelName,
          messages,
          toolCount,
        });

        // A broken stream/callback can follow an accepted, billed generation.
        // Never create another generation to hide that ambiguous outcome.
        throw streamError;
      }
    } else {
      console.log(`⏱️ [TIMING] Calling ${provider.toUpperCase()} API...`);
      const apiStartTime = Date.now();
      let completion;
      const boundaryBilling = executionBoundary?.billing;
      let dispatched = false;
      let dispatchFailure: unknown;
      const beforeDispatch = boundaryBilling ? async (request: Record<string, any>) => {
        if (!dispatched) {
          try {
            await runBoundaryBillingHook(() => boundaryBilling.beforeDispatch({ eventId,
              inputBytes: Buffer.byteLength(JSON.stringify(request), 'utf8'), maxOutputTokens: request.max_tokens }));
          } catch (error) {
            dispatchFailure = error;
            // A terminal billing error may carry status=503. Never let the
            // provider admission retrier interpret a host rejection as retryable.
            await runBoundaryHook(async () => { throw error; });
          }
          dispatched = true;
        }
      } : undefined;
      try {
        completion = await observeCompletedTextRequest(modelName,
          () => requestOpenRouterChat(completionOptions, request => this.createModelCompletion(request, executionBoundary, system || '', beforeDispatch)),
          { apiKey: this.observationApiKey, signal: executionBoundary?.signal });
      } catch (apiErr: any) {
        if (dispatchFailure) throw dispatchFailure;
        if (boundaryBilling && dispatched) {
          await runBoundaryBillingHook(() => boundaryBilling.failed({ eventId, error: apiErr, model: modelName }));
        }
        if (apiErr?.name === 'RecoveryError') throw apiErr;
        if (apiErr?.name === 'OpenRouterBillingError') throw apiErr;
        if (!boundaryBilling) await settleUncertainRequest(billingSiteId, eventId, apiErr, modelName);
        if (provider === 'azure' && isAzureInvalidImageError(apiErr)) {
          sanitizeMessagesForAzureVisionImages(messages);
          completion = await observeCompletedTextRequest(modelName,
            () => this.createModelCompletion(completionOptions, executionBoundary, system || ''),
            { apiKey: this.observationApiKey, signal: executionBoundary?.signal });
        } else {
          logChatCompletionFailure(apiErr, {
            provider,
            stage: 'non-stream',
            modelName,
            messages,
            toolCount,
          });
          throw apiErr;
        }
      }
      onAccepted();
      const apiEndTime = Date.now();
      const apiDuration = apiEndTime - apiStartTime;
      console.log(`⏱️ [TIMING][${provider}] Response received in ${apiDuration}ms (${(apiDuration/1000).toFixed(1)}s)`);

      if (boundaryBilling) {
        await runBoundaryBillingHook(() => boundaryBilling.settle({ eventId, usage: completion?.usage,
          generationId: completion?.id, model: completion?.model || modelName }));
      } else {
        await settleCompletion(billingSiteId, eventId, completion?.usage, completion?.id, completion?.model || modelName);
      }
      const choice = completion?.choices?.[0];
      if ((completion as any)?.error || (choice as any)?.finish_reason === 'error') {
        throw new Error('OpenRouter completion failed after acceptance');
      }
      if (!choice?.message) throw new Error('OpenRouter completion message is missing');
      response = {
        message: choice.message,
        usage: completion.usage,
        generationId: completion.id,
        model: completion.model,
        finish_reason: choice.finish_reason ?? undefined,
      } as any;
    }
    return response;
  }
}
