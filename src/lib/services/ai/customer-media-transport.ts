import { randomUUID } from 'node:crypto';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import { beginCustomerInference, recordCustomerInference, CustomerReceiptError } from '../billing/customer-inference-receipts';
import { getExecutionRouting, resolveCustomerDispatch, CustomerRoutingError } from './customer-routing';

/** Fixed protocols only. Secrets are resolved for this dispatch, never stored on a job/client. */
export async function customerMediaJson<T>(options: {
  capability: 'embedding' | 'image' | 'transcription';
  body: Record<string, unknown>;
  expectedModel?: string;
  signal?: AbortSignal;
  timeout?: number;
  operationKey?: string;
  validate: (data: any, model: string, eventId: string) => Promise<T> | T;
}): Promise<T> {
  const routing = getExecutionRouting();
  if (routing?.payer !== 'customer') throw new CustomerRoutingError('CUSTOMER_ROUTE_REQUIRED');
  const selected = await resolveCustomerDispatch(routing, options.capability);
  if (options.expectedModel && options.expectedModel !== selected.modelId) {
    throw new CustomerRoutingError('CUSTOMER_MODEL_BINDING_MISMATCH');
  }
  const body = JSON.stringify({ ...options.body, model: selected.modelId,
    ...(options.capability === 'image' && selected.providerTag ? {
      provider: { only: [selected.providerTag], allow_fallbacks: false },
    } : {}),
  });
  if (Buffer.byteLength(body, 'utf8') > (options.capability === 'transcription' ? 36 : 4) * 1024 * 1024) {
    throw new CustomerRoutingError('CUSTOMER_REQUEST_TOO_LARGE');
  }
  if (options.capability === 'embedding') {
    if (selected.embeddingDimensions !== undefined && selected.embeddingDimensions !== options.body.dimensions) {
      throw new CustomerRoutingError('CUSTOMER_EMBEDDING_DIMENSIONS_MISMATCH');
    }
    const texts = Array.isArray(options.body.input) ? options.body.input : [options.body.input];
    // Conservative UTF-8 byte budget, never a global model's context substitute.
    if (!selected.contextLength || texts.some(text => typeof text !== 'string'
        || Buffer.byteLength(text, 'utf8') + 32 > selected.contextLength!)) {
      throw new CustomerRoutingError('CUSTOMER_EMBEDDING_CONTEXT_UNVERIFIED');
    }
  }
  if (options.signal?.aborted) throw new CustomerRoutingError('CUSTOMER_REQUEST_CANCELLED');
  const eventId = await beginCustomerInference({ routing, capability: options.capability,
    eventId: randomUUID(), operationKey: options.operationKey, requestedModel: selected.modelId });
  let data: any;
  let result: T;
  try {
    const path = { image: 'images', embedding: 'embeddings', transcription: 'audio/transcriptions' }[options.capability];
    const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${selected.apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 180_000)])
        : AbortSignal.timeout(options.timeout ?? 180_000),
    });
    if (!response.ok) throw new Error();
    data = JSON.parse((await readResponseWithLimit(response,
      options.capability === 'image' ? 90 * 1024 * 1024 : 16 * 1024 * 1024)).toString('utf8'));
    if (!data || data.error) throw new Error();
    result = await options.validate(data, selected.modelId, eventId);
  } catch {
    // Once the POST was attempted, neither network failure nor malformed output authorizes replay.
    await recordCustomerInference({ routing, capability: options.capability, eventId,
      requestedModel: selected.modelId, generationId: safeId(data?.id), usage: data?.usage, uncertain: true });
    throw new CustomerReceiptError();
  }
  await recordCustomerInference({ routing, capability: options.capability, eventId,
    requestedModel: selected.modelId, model: typeof data.model === 'string' ? data.model : undefined,
    generationId: safeId(data.id), usage: data.usage });
  return result;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined;
}