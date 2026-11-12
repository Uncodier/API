import { z } from 'zod';
import { CAPABILITIES, type Capabilities, type Capability, type CatalogModel, OpenRouterError } from './types';
export const modelIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const modelSchema = z.object({
  id: modelIdSchema, name: z.string().max(300).optional(),
  architecture: z.object({ input_modalities: z.array(z.string().max(40)).max(20), output_modalities: z.array(z.string().max(40)).max(20) }),
  supported_parameters: z.array(z.string().max(80)).max(100).default([]),
  context_length: z.number().int().positive().max(1e9).nullable().optional(),
  endpoints: z.array(z.string().max(120)).max(30).optional(),
  pricing: z.object(Object.fromEntries(['prompt', 'completion', 'request', 'image_output', 'audio', 'audio_output', 'input_cache_read', 'input_cache_write'].map(key => [key, z.string().max(40).optional()]))).optional(),
  description: z.string().max(100000).optional(),
  top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullable().optional() }).nullable().optional(),
});
const MAX_BYTES = 8 * 1024 * 1024;
async function providerJson(url: string, apiKey: string): Promise<unknown> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    if (!response.ok) throw new OpenRouterError(response.status === 401 || response.status === 403 ? 'invalid_key' : 'catalog_unavailable', 'OpenRouter account validation failed', response.status === 401 || response.status === 403 ? 422 : 502);
    if (!response.body) throw new Error();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > MAX_BYTES) throw new Error(); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof OpenRouterError) throw error;
    throw new OpenRouterError('catalog_unavailable', 'OpenRouter catalog could not be validated', 502);
  }
}
export function normalizeCatalog(value: unknown): CatalogModel[] {
  // Reject partial responses instead of interpreting invalid rows as model removals.
  const result = z.object({ data: z.array(modelSchema).max(10000), links: z.object({ next: z.string().nullable().optional() }).optional(), total_count: z.number().optional() }).safeParse(value);
  if (!result.success) throw new OpenRouterError('invalid_catalog', 'OpenRouter returned an incomplete catalog', 502);
  if (result.data.links?.next || (result.data.total_count !== undefined && result.data.total_count !== result.data.data.length)) throw new OpenRouterError('invalid_catalog', 'OpenRouter returned a partial catalog', 502);
  const seen = new Set<string>();
  return result.data.data.map(model => {
    if (seen.has(model.id)) throw new OpenRouterError('invalid_catalog', 'OpenRouter returned an ambiguous catalog', 502);
    seen.add(model.id);
    const pricing = Object.fromEntries(Object.entries(model.pricing ?? {}).filter(([key, price]) =>
      ['prompt', 'completion', 'request', 'image_output', 'audio', 'audio_output', 'input_cache_read', 'input_cache_write'].includes(key)
      && typeof price === 'string' && price.trim() !== '' && Number.isFinite(Number(price)) && Number(price) >= 0).map(([key, price]) => [key, Number(price)]));
    return { id: model.id, name: model.name || model.id, inputModalities: model.architecture.input_modalities, outputModalities: model.architecture.output_modalities, supportedParameters: model.supported_parameters, contextLength: model.context_length ?? null,
      ...(model.endpoints ? { endpoints: model.endpoints } : {}), ...(model.pricing ? { pricing } : {}),
      ...(model.description ? { description: model.description.slice(0, 600) } : {}),
      ...(model.top_provider?.max_completion_tokens ? { maxCompletionTokens: model.top_provider.max_completion_tokens } : {}) };
  });
}
export async function discoverCatalog(apiKey: string): Promise<CatalogModel[]> {
  const key = await providerJson('https://openrouter.ai/api/v1/key', apiKey);
  if (!z.object({ data: z.object({ is_free_tier: z.boolean() }) }).safeParse(key).success) throw new OpenRouterError('invalid_key', 'OpenRouter key metadata could not be validated', 422);
  return normalizeCatalog(await providerJson('https://openrouter.ai/api/v1/models/user?output_modalities=all', apiKey));
}
export function compatibility(capability: Capability, model: CatalogModel): { status: 'unverified' | 'unavailable'; reason: string } {
  const text = model.inputModalities.includes('text') && model.outputModalities.includes('text');
  const supported = capability === 'text' || capability === 'summary' ? text
    : capability === 'tools' ? text && model.supportedParameters.includes('tools')
    : capability === 'structured' ? text && model.supportedParameters.includes('structured_outputs')
    : capability === 'vision' ? text && model.inputModalities.includes('image')
    : capability === 'image' ? model.outputModalities.includes('image') && !!model.endpoints?.includes('/api/v1/images')
    : capability === 'speech' ? (model.outputModalities.includes('audio') || model.outputModalities.includes('speech')) && !!model.endpoints?.includes('/api/v1/audio/speech')
    : capability === 'transcription' ? model.inputModalities.includes('audio') && !!model.endpoints?.includes('/api/v1/audio/transcriptions')
    : capability === 'video' ? model.outputModalities.includes('video') && !!model.endpoints?.includes('/api/v1/videos')
    : capability === 'embedding' ? model.outputModalities.includes('embeddings') && !!model.endpoints?.includes('/api/v1/embeddings') : false;
  if (supported) return { status: 'unverified', reason: 'Catalog compatible; no paid execution or funding verification has been performed.' };
  const reason = capability === 'image' ? 'Image execution requires successful live verification on this connection; no paid probe has been authorized.'
    : capability === 'embedding' ? 'Embedding space and dimensions must be explicitly bound to the existing index before enablement.'
    : ['speech', 'transcription', 'video'].includes(capability) ? 'No verified compatible media protocol is enabled for this connection.'
    : 'Model does not advertise the required input, output, or supported parameters.';
  return { status: 'unavailable', reason };
}
export function emptyCapabilities(): Capabilities {
  return Object.fromEntries(CAPABILITIES.map(id => [id, { mode: 'disabled', modelId: null, status: 'disabled', reason: 'Not configured. Select a compatible model manually.' }])) as Capabilities;
}
export function evaluateCapabilities(previous: Capabilities, models: CatalogModel[]): Capabilities {
  return Object.fromEntries(CAPABILITIES.map(id => {
    const pin = previous[id];
    if (pin.mode === 'disabled') return [id, { ...pin, status: 'disabled', reason: 'Disabled by policy. No platform-funded fallback.' }];
    const modelId = pin.mode === 'automatic' ? pin.recommendation?.modelId ?? null : pin.modelId;
    const model = models.find(model => model.id === modelId);
    let result = model ? compatibility(id, model) : { status: 'unavailable', reason: 'Pinned model is absent from the account-filtered catalog. The pin was preserved.' };
    if (id === 'image' && result.status === 'unverified') {
      result = pin.verification?.modelId === modelId && pin.verification.adapterVersion === 'openrouter-images-png-v1'
        && Date.parse(pin.verification.expiresAt) > Date.now() ? { status: 'available', reason: 'Connection-specific image generation and persistence verified.' }
        : { status: 'unavailable', reason: 'An authorized real image generation and persistence verification is required.' };
    }
    if (id === 'embedding' && result.status === 'unverified' && !pin.embeddingDimensions) result = { status: 'unavailable', reason: 'Bind the exact existing embedding model and dimensions before use.' };
    return [id, { ...pin, modelId, ...result }];
  })) as Capabilities;
}
