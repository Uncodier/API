import { z } from 'zod';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import { OpenRouterError } from './types';

/** Only complete fixed per-image prices can bound a synthetic n=1 probe. No token/MP guesses. */
export async function quoteImageVerification(apiKey: string, modelId: string, budget: number) {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/.test(modelId)) throw new OpenRouterError('quote_unavailable', 'A canonical image model is required', 422);
  const response = await fetch(`https://openrouter.ai/api/v1/images/models/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new OpenRouterError('quote_unavailable', 'Image endpoint quote is unavailable', 422);
  const value = JSON.parse((await readResponseWithLimit(response, 256000)).toString('utf8'));
  const result = z.object({ id: z.literal(modelId), endpoints: z.array(z.object({ provider_tag: z.string().max(100).nullable(),
    supported_parameters: z.record(z.unknown()), pricing: z.array(z.object({ billable: z.string(), unit: z.string(), cost_usd: z.number().finite().nonnegative(), variant: z.string().nullable().optional() })).min(1).max(30) })).max(100) }).safeParse(value);
  if (!result.success) throw new OpenRouterError('quote_unavailable', 'Image endpoint pricing could not be validated', 422);
  const candidates = result.data.endpoints.flatMap(endpoint => {
    const format = endpoint.supported_parameters.output_format as { type?: string; values?: unknown[] } | undefined;
    if (!endpoint.provider_tag || !/^[a-zA-Z0-9._/-]+$/.test(endpoint.provider_tag) || format?.type !== 'enum' || !format.values?.includes('png')
      || endpoint.pricing.some(price => price.billable !== 'output_image' || price.unit !== 'image' || price.variant)) return [];
    const cost = endpoint.pricing.reduce((sum, price) => sum + price.cost_usd, 0);
    return cost <= budget ? [{ providerTag: endpoint.provider_tag, maximumQuotedCostUsd: cost }] : [];
  });
  candidates.sort((a,b) => a.maximumQuotedCostUsd - b.maximumQuotedCostUsd || a.providerTag.localeCompare(b.providerTag));
  if (!candidates.length) throw new OpenRouterError('quote_unavailable', 'No fixed-price PNG endpoint fits this budget. Token, megapixel and variant prices require a provider spending limit before verification.', 422);
  return candidates[0];
}