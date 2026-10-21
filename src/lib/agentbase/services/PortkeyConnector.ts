/** OpenRouter Chat Completions connector. The old export is a source compatibility alias. */
import type { OpenRouterConfig, OpenRouterModelOptions } from '../models/types';
import { randomUUID } from 'node:crypto';
import { createOpenRouterClient, isOpenRouterReasoningModel, resolveOpenRouterModel } from '@/lib/services/ai/openrouter';
import { recordTelemetry } from '@/lib/status/telemetry';
import { getTextObservationKey } from '@/lib/status/handlers/ai/passive-probes';
import { formatOpenAiNonStreamResponse, throwIfCompletionError } from './llm-fallback';

function hasGeneratedOutput(choices: any, streaming = false): boolean {
  return Array.isArray(choices) && choices.some(choice => {
    const message = streaming ? choice?.delta : choice?.message;
    return (typeof message?.content === 'string' && !!message.content.trim()) ||
      (Array.isArray(message?.tool_calls) && message.tool_calls.some((call: any) =>
        (typeof call?.function?.name === 'string' && !!call.function.name.trim()) ||
        (typeof call?.function?.arguments === 'string' && !!call.function.arguments.trim())));
  });
}

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
    const platformCredential = this.config.apiKey === undefined ||
      (!!process.env.OPENROUTER_API_KEY?.trim() && this.config.apiKey.trim() === process.env.OPENROUTER_API_KEY.trim());
    const observe = async (status: 'up' | 'down') => {
      if (!platformCredential) return;
      await recordTelemetry(getTextObservationKey(model), status,
        status === 'up' ? 'Text request completed with generated output' : 'Text request failed or returned no generated output',
        Date.now() - startedAt).catch(() => {});
    };
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
        // Observe outside the existing billing iterator: connection acceptance and
        // caller cancellation are not evidence of completed generation.
        const observedStream = (async function* () {
          let generated = false;
          let failed = false;
          try {
            for await (const chunk of stream as AsyncIterable<any>) {
              generated ||= hasGeneratedOutput(chunk?.choices, true);
              failed ||= !!(chunk?.error || chunk?.body?.error);
              yield chunk;
            }
          } catch (error) {
            await observe('down');
            throw error;
          }
          // A generator return() skips this path; never mark an abandoned stream up.
          await observe(generated && !failed ? 'up' : 'down');
        })();
        return { stream: observedStream, isStream: true, modelInfo: { model, provider: 'openrouter' } };
      }
      // Accepted work is billable even when choices are absent or the provider returns an error envelope.
      await charge((response as any)?.usage, (response as any)?.id, (response as any)?.model);
      throwIfCompletionError(response);
      const result = formatOpenAiNonStreamResponse(response, 'openrouter', model);
      await observe(hasGeneratedOutput((response as any)?.choices) ? 'up' : 'down');
      return result;
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
      await observe('down');
      // Preserve SDK status/code and never turn failures into success-shaped responses.
      throw error;
    }
  }
}

export { OpenRouterConnector as PortkeyConnector };