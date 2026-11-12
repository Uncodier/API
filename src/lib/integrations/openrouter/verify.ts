import 'server-only';
import { createHash } from 'node:crypto';
import { decryptCredential } from './crypto';
import { claimSetup, finishSetup } from './setup-store';
import { publishConnection } from './store';
import { quoteImageVerification } from './image-quote';
import { evaluateCapabilities } from './catalog';
import { OpenRouterError, type ConnectionRow } from './types';
import type { Mutation } from './validation';

export async function verifyImage(row: ConnectionRow, actorId: string, input: Extract<Mutation, {operation:'verify'}>) {
  const model = row.catalog.find(model => model.id === input.modelId);
  if (!model?.outputModalities.includes('image') || !model.endpoints?.includes('/api/v1/images')) throw new OpenRouterError('invalid_model', 'Select a compatible image model from this account catalog', 422);
  const apiKey = decryptCredential(row.encrypted_credential!, row.site_id, row.id, row.credential_version);
  const quote = await quoteImageVerification(apiKey, input.modelId, input.maxCostUsd);
  const fingerprint = createHash('sha256').update(JSON.stringify([row.credential_version,input.modelId,quote,'openrouter-images-png-v1'])).digest('hex');
  await claimSetup(row, actorId, input.operationId, 'verify', fingerprint, input.maxCostUsd);
  try {
    const { verifyCustomerImage } = await import('@/lib/services/ai/customer-verification');
    const result = await verifyCustomerImage({ apiKey, modelId: input.modelId, siteId: row.site_id, connectionId: row.id,
      credentialVersion: row.credential_version, policyVersion: row.policy_version, operationId: input.operationId,
      consent: true, maxCostUsd: input.maxCostUsd, ...quote });
    await finishSetup(row.site_id, input.operationId, 'completed', { gatewayCost: result.usage.cost, generationId: result.generationId,
      modelId: input.modelId, artifactId: result.artifactId, adapterVersion: result.adapterVersion, actualModel: result.actualModel, providerTag: quote.providerTag, platformCharge: 0 });
    const capabilities = structuredClone(row.capabilities);
    capabilities.image.verification = { modelId: input.modelId, credentialVersion: row.credential_version, adapterVersion: result.adapterVersion,
      expiresAt: new Date(Date.now() + 23*60*60*1000).toISOString(), operationId: input.operationId, artifactId: result.artifactId, providerTag: quote.providerTag };
    return await publishConnection(row.site_id, actorId, row.revision, { ...row, capabilities: evaluateCapabilities(capabilities,row.catalog) });
  } catch (error) {
    if (error instanceof OpenRouterError && error.code === 'revision_conflict') throw error;
    await finishSetup(row.site_id,input.operationId,'uncertain',{ platformCharge:0 }).catch(() => undefined);
    throw new OpenRouterError('verification_uncertain','Image verification was not published. Check setup status before authorizing another attempt.',409);
  }
}