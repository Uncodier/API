import { readResponseWithLimit } from '@/lib/security/limited-response';
import { CustomerRoutingError, type ExecutionRoutingReference } from './customer-routing';
import { validateCustomerPng } from './customer-image-artifact';
import { persistCustomerImage } from './customer-image-persistence';
import { CustomerReceiptError } from '../billing/customer-inference-receipts';

export const CUSTOMER_IMAGE_ADAPTER_VERSION = 'openrouter-images-png-v1';
export interface CustomerImageVerificationInput {
  apiKey: string; modelId: string; siteId: string; connectionId: string;
  credentialVersion: number; policyVersion: number; operationId: string;
  consent: true; maxCostUsd: number;
  providerTag: string;
  /** Host-derived conservative full-generation quote, NEVER request JSON or an estimate. */
  maximumQuotedCostUsd: number;
}

/** Host-only runner. Caller authenticates manager, claims single-use setup operation and
 * derives an authoritative price ceiling before invoking. No import-time or automatic probes.
 * This deliberately does not relax the ordinary runtime's verified-image capability gate.
 */
export async function verifyCustomerImage(input: CustomerImageVerificationInput) {
  if (input.consent !== true || !Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0 || input.maxCostUsd > 1
      || !Number.isFinite(input.maximumQuotedCostUsd) || input.maximumQuotedCostUsd < 0
      || input.maximumQuotedCostUsd > input.maxCostUsd || !input.apiKey?.trim()
      || !/^[a-zA-Z0-9._/-]{1,100}$/.test(input.providerTag)
      || !/^[a-zA-Z0-9._/-]{1,200}$/.test(input.modelId)
      || !/^[a-f0-9-]{36}$/i.test(input.operationId)) {
    throw new CustomerRoutingError('CUSTOMER_VERIFICATION_CONSENT_OR_BUDGET_REQUIRED');
  }
  const routing: ExecutionRoutingReference = { payer: 'customer', siteId: input.siteId,
    connectionId: input.connectionId, credentialVersion: input.credentialVersion, policyVersion: input.policyVersion };
  let data: any; let artifact: Awaited<ReturnType<typeof persistCustomerImage>>;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(180_000),
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: input.modelId, prompt: 'A solid blue circle on a plain white background.',
        n: 1, output_format: 'png', provider: { only: [input.providerTag], allow_fallbacks: false } }),
    });
    if (!response.ok) throw new Error();
    data = JSON.parse((await readResponseWithLimit(response, 24 * 1024 * 1024)).toString('utf8'));
    if (data.error || data.data?.length !== 1 || (data.data[0].media_type && data.data[0].media_type !== 'image/png')) throw new Error();
    const base64Data = validateCustomerPng(data.data[0].b64_json);
    // Unknown cost or serving model is not successful capability evidence.
    if (data.model !== input.modelId || typeof data.id !== 'string'
        || !Number.isFinite(data.usage?.cost) || data.usage.cost < 0 || data.usage.cost > input.maxCostUsd) throw new Error();
    artifact = await persistCustomerImage({ base64Data, siteId: input.siteId, model: input.modelId,
      eventId: input.operationId, routing, generationId: data.id });
  } catch {
    // The caller's durable setup claim remains uncertain. It must persist failure
    // there, not use execution receipts which require a selected connection.
    throw new CustomerReceiptError();
  }
  return { generationId: data.id as string, usage: { cost: data.usage.cost as number },
    artifactId: artifact.artifact_id, receiptEventId: input.operationId,
    adapterVersion: CUSTOMER_IMAGE_ADAPTER_VERSION, actualModel: data.model as string };
}