import type OpenAI from 'openai';
import { CustomerRoutingError, getExecutionRouting, getCustomerCapability, resolveCustomerDispatch,
  type CustomerCapability, type ExecutionRoutingReference } from './customer-routing';
import { beginCustomerInference, rejectCustomerInference, recordCustomerInference, CustomerReceiptError } from '../billing/customer-inference-receipts';
import type { ChatCapability } from '@/lib/integrations/openrouter/chat-contract';

function capabilityFor(request: any): CustomerCapability {
  if (getCustomerCapability() === 'summary') return 'summary';
  if (Array.isArray(request.messages) && request.messages.some((m: any) =>
    Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))) return 'vision';
  if (request.tools?.length) return 'tools';
  if (request.response_format) return 'structured';
  return 'text';
}

/** Only the implemented protocol is exposed; unsupported SDK methods cannot access global credentials. */
export function customerChatClient(routing: ExecutionRoutingReference,
  factory: (apiKey: string) => OpenAI): OpenAI {
  const blocked = () => { throw new CustomerRoutingError('CUSTOMER_ADAPTER_UNSUPPORTED'); };
  const create = async (request: any, options?: any) => {
    if (getExecutionRouting() !== routing) throw new CustomerRoutingError('CUSTOMER_CLIENT_SCOPE_MISMATCH');
    if (!request || typeof request !== 'object') throw new CustomerRoutingError('INVALID_CUSTOMER_REQUEST');
    const capability = capabilityFor(request);
    const required = [capability, request.tools?.length ? 'tools' : null,
      request.response_format ? 'structured' : null,
      request.messages?.some((m: any) => Array.isArray(m.content) &&
        m.content.some((p: any) => p.type === 'image_url')) ? 'vision' : null].filter(Boolean) as ChatCapability[];
    // Validate one current credential/catalog snapshot. Independent single-purpose
    // pins may differ; the primary selected model must satisfy the full request.
    const selected = await resolveCustomerDispatch(routing, capability, required);
    if (request.modalities?.some((m: string) => m !== 'text') || request.audio || request.plugins) blocked();
    if (request.messages?.some((message: any) => Array.isArray(message.content) &&
        message.content.some((part: any) => !['text', 'image_url'].includes(part?.type)))) blocked();
    const outputTokens = request.max_tokens ?? 8192;
    // Conservative byte bound includes tool schemas/images; never budget the substituted global model.
    const inputBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (!selected.contextLength || !Number.isSafeInteger(outputTokens) || outputTokens < 1 ||
        (selected.maxCompletionTokens != null && outputTokens > selected.maxCompletionTokens) ||
        inputBytes + outputTokens > selected.contextLength) {
      throw new CustomerRoutingError('CUSTOMER_CONTEXT_BUDGET_EXCEEDED');
    }
    const client = factory(selected.apiKey);
    // Customer policy owns model and provider fallback, not model/client arguments.
    const payload = { ...request, model: selected.modelId, user: routing.siteId,
      max_tokens: outputTokens,
      max_completion_tokens: undefined,
      provider: { allow_fallbacks: false, require_parameters: true }, route: undefined, models: undefined,
      // Legacy callers tune the global model. Do not forward those model-specific hints.
      temperature: undefined, top_p: undefined, reasoning: undefined, verbosity: undefined,
      ...(request.stream ? { stream_options: { include_usage: true } } : {}) };
    let response: any;
    const eventId = await beginCustomerInference({ routing, capability, requestedModel: selected.modelId });
    try {
      response = await client.chat.completions.create(payload, {
        signal: options?.signal, timeout: options?.timeout, maxRetries: 0,
      });
    } catch (error: any) {
      const generationId = error?.generationId || error?.error?.generation_id || error?.error?.metadata?.generation_id;
      const usage = error?.usage || error?.error?.usage;
      const predispatch = !generationId && !usage && ([400, 401, 402, 403, 404, 405, 409, 422, 429].includes(error?.status) ||
        ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.cause?.code));
      if (!predispatch) await recordCustomerInference({ routing, capability, eventId,
        generationId, usage, requestedModel: selected.modelId, uncertain: true });
      // Never retain provider headers/body/cause (may contain credentials) or authorize replay.
      if (!predispatch) throw new CustomerReceiptError();
      await rejectCustomerInference(eventId, routing);
      throw new CustomerRoutingError(error?.status === 402 ? 'CUSTOMER_FUNDING_REQUIRED' : 'CUSTOMER_PROVIDER_REJECTED');
    }
    if (!request.stream) {
      await recordCustomerInference({ routing, capability, eventId, generationId: response?.id,
        usage: response?.usage, model: response?.model, requestedModel: selected.modelId,
        provider: response?.provider });
      return response;
    }
    return (async function* () {
      let usage: unknown, generationId: string | undefined, model: string | undefined, provider: string | undefined;
      let complete = false;
      let terminal = false;
      try {
        for await (const chunk of response) {
          if (chunk?.usage) usage = chunk.usage;
          if (chunk?.id) generationId = chunk.id;
          if (chunk?.model) model = chunk.model;
          if (typeof chunk?.provider === 'string') provider = chunk.provider;
          if (chunk?.error || chunk?.choices?.some((choice: any) => choice.finish_reason === 'error')) {
            throw new CustomerReceiptError();
          }
          terminal ||= chunk?.choices?.some((choice: any) =>
            ['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) === true;
          yield chunk;
        }
        if (!terminal) throw new CustomerReceiptError();
        complete = true;
      } catch { throw new CustomerReceiptError(); }
      finally {
        await recordCustomerInference({ routing, capability, eventId, generationId, usage, model,
          requestedModel: selected.modelId, provider, uncertain: !complete });
      }
    })();
  };
  return new Proxy({ chat: { completions: { create } } }, {
    get(target, property) {
      if (property === 'chat') return target.chat;
      if (property === 'baseURL') return 'https://openrouter.ai/api/v1';
      if (property === 'maxRetries') return 0;
      return blocked();
    },
  }) as unknown as OpenAI;
}