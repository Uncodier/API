/** OpenRouter Chat Completions connector. The old export is a source compatibility alias. */
import type { OpenRouterConfig, OpenRouterModelOptions } from '../models/types';
import { randomUUID } from 'node:crypto';
import { createOpenRouterClient, isOpenRouterReasoningModel, resolveOpenRouterModel } from '@/lib/services/ai/openrouter';
import { recordTelemetry } from '@/lib/status/telemetry';
import { formatOpenAiNonStreamResponse, throwIfCompletionError } from './llm-fallback';

export class OpenRouterConnector {
  constructor(
    private readonly config: OpenRouterConfig = {},
    private readonly defaultOptions: Partial<OpenRouterModelOptions> = {},
  ) {}

  async callAgent(
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: any; [key: string]: any }>,
    options?: Partial<OpenRouterModelOptions>,
  ): Promise<any> {
    if (this.config.virtualKeys || this.config.useAzure || this.config.azureOptions) {
      throw new Error('Legacy Portkey/Azure credentials are not accepted. Configure an OpenRouter API key without virtualKeys.');
    }
    if (!messages.some(message => message.role === 'system')) {
      throw new Error('OpenRouter requires a system message with agent_background');
    }
    const merged = { modelType: 'openrouter', stream: false, ...this.defaultOptions, ...options };
    const model = resolveOpenRouterModel(merged.modelId, merged.modelType);
    const reasoningModel = isOpenRouterReasoningModel(model);
    // Fixed OpenRouter transport. No virtual keys, custom base URL, or other-account fallback.
    const client = createOpenRouterClient({ apiKey: this.config.apiKey, timeout: this.config.timeout, maxRetries: 0 });
    const request: any = {
      model,
      messages,
      stream: merged.stream === true,
      ...(merged.siteId ? { user: merged.siteId } : {}),
      ...(merged.maxTokens !== undefined ? { max_tokens: merged.maxTokens } : {}),
      ...(merged.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    };
    if (merged.stream) request.stream_options = { include_usage: true };
    if (reasoningModel) {
      // OpenRouter's namespaced GPT/o-series models do not accept sampling controls.
      if (merged.reasoningEffort) request.reasoning = { effort: merged.reasoningEffort === 'minimal' && /^openai\/gpt-6/.test(model) ? 'low' : merged.reasoningEffort };
      if (merged.verbosity) request.verbosity = merged.verbosity;
    } else {
      if (merged.temperature !== undefined) request.temperature = merged.temperature;
      if (merged.topP !== undefined) request.top_p = merged.topP;
    }

    const eventId = randomUUID();
    const startedAt = Date.now();
    let accepted = false;
    const charge = async (usage: unknown, generationId?: string, responseModel?: string) => {
      if (!merged.siteId) return;
      const { chargeOpenRouterUsage } = await import('@/lib/services/billing/openrouter-usage-billing');
      await chargeOpenRouterUsage({ siteId: merged.siteId, usage, generationId, eventId,
        metadata: { model: responseModel || model, context: 'agentbase' } });
    };
    try {
      const response = await client.chat.completions.create(request);
      accepted = true;
      // Keep the historical telemetry system key for database compatibility.
      void recordTelemetry('ai_portkey', 'up', `OpenRouter: ${model}`, Date.now() - startedAt).catch(() => {});
      if (merged.stream) {
        // Preserve chunk metadata, but settle before the caller can finish the turn and run tools.
        const stream = merged.siteId ? (async function* () {
          let usage: unknown;
          let generationId: string | undefined;
          let responseModel: string | undefined;
          try {
            for await (const chunk of response as unknown as AsyncIterable<any>) {
              if (chunk.id) generationId = chunk.id;
              if (chunk.model) responseModel = chunk.model;
              if (chunk.usage) usage = chunk.usage;
              throwIfCompletionError(chunk);
              yield chunk;
            }
          } finally {
            // Broken/cancelled streams without cost must be persisted for reconciliation too.
            await charge(usage, generationId, responseModel);
          }
        })() : response;
        return { stream, isStream: true, modelInfo: { model, provider: 'openrouter' } };
      }
      // Accepted work is billable even when choices are absent or the provider returns an error envelope.
      await charge((response as any)?.usage, (response as any)?.id, (response as any)?.model);
      throwIfCompletionError(response);
      return formatOpenAiNonStreamResponse(response, 'openrouter', model);
    } catch (error) {
      if (!accepted) {
        const failure = error as any;
        const body = failure?.error;
        const generationId = failure?.generationId || body?.generation_id || body?.metadata?.generation_id;
        const usage = failure?.usage || body?.usage;
        const status = failure?.status;
        const rejectedBeforeConnection = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(failure?.cause?.code);
        if (generationId || usage || (!rejectedBeforeConnection && (typeof status !== 'number' || status === 408))) {
          await charge(usage, generationId);
        }
      }
      void recordTelemetry('ai_portkey', 'down', `OpenRouter request failed: ${model}`, Date.now() - startedAt).catch(() => {});
      // Preserve SDK status/code and never turn failures into success-shaped responses.
      throw error;
    }
  }
}

export { OpenRouterConnector as PortkeyConnector };