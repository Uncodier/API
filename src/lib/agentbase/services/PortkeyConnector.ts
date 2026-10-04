/** OpenRouter Chat Completions connector. The old export is a source compatibility alias. */
import type { OpenRouterConfig, OpenRouterModelOptions } from '../models/types';
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

    const startedAt = Date.now();
    try {
      const response = await client.chat.completions.create(request);
      throwIfCompletionError(response);
      // Keep the historical telemetry system key for database compatibility.
      void recordTelemetry('ai_portkey', 'up', `OpenRouter: ${model}`, Date.now() - startedAt).catch(() => {});
      if (merged.stream) return { stream: response, isStream: true, modelInfo: { model, provider: 'openrouter' } };
      return formatOpenAiNonStreamResponse(response, 'openrouter', model);
    } catch (error) {
      void recordTelemetry('ai_portkey', 'down', `OpenRouter request failed: ${model}`, Date.now() - startedAt).catch(() => {});
      // Preserve SDK status/code and never turn failures into success-shaped responses.
      throw error;
    }
  }
}

export { OpenRouterConnector as PortkeyConnector };