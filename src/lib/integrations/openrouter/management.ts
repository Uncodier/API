import 'server-only';
import { randomUUID } from 'node:crypto';
import { discoverCatalog, emptyCapabilities, evaluateCapabilities } from './catalog';
import { decryptCredential, encryptCredential } from './crypto';
import { claimRefresh, publishConnection, readConnection, releaseRefresh } from './store';
import { type ConnectionRow, OpenRouterError, rolloutEnabled } from './types';
import { type Mutation } from './validation';
import { combinedChatPolicyIssue } from './chat-contract';

export function connectionDto(row: ConnectionRow | null) {
  return { canManage: true, rolloutEnabled: rolloutEnabled(), selectionMode: 'automatic-or-manual', paidSelectionEnabled: true,
    connection: row ? { id: row.id, siteId: row.site_id, status: row.status, selected: row.selected,
      revision: row.revision, policyVersion: row.policy_version, credentialVersion: row.credential_version,
      capabilities: row.capabilities, catalogUpdatedAt: row.catalog_updated_at, verifiedAt: row.verified_at, updatedAt: row.updated_at } : null };
}
export async function mutateConnection(actorId: string, input: Mutation) {
  if ('selected' in input && input.selected === true && !rolloutEnabled()) throw new OpenRouterError('OPENROUTER_RUNTIME_NOT_READY', 'Customer execution is not enabled until runtime coverage is verified', 409);
  const current = await readConnection(input.siteId);
  if ((current?.revision ?? 0) !== input.expectedRevision) throw new OpenRouterError('revision_conflict', 'Connection changed. Reload before saving.', 409);
  if (input.operation === 'connect') {
    const id = current?.id ?? randomUUID(); const version = (current?.credential_version ?? 0) + 1;
    // Check encryption configuration before issuing even free provider reads.
    const encrypted = encryptCredential(input.apiKey, input.siteId, id, version);
    const catalog = await discoverCatalog(input.apiKey); const now = new Date().toISOString();
    const previousCapabilities = structuredClone(current?.capabilities ?? emptyCapabilities());
    for (const policy of Object.values(previousCapabilities)) delete policy.verification;
    const connectionPolicies = evaluateCapabilities(previousCapabilities,catalog);
    const connectionIssue = combinedChatPolicyIssue(connectionPolicies,catalog);
    if(connectionIssue)throw new OpenRouterError('combined_capability_unsupported',connectionIssue,422);
    const candidate: ConnectionRow = { id, site_id: input.siteId, status: 'connected', selected: false,
      revision: input.expectedRevision + 1, policy_version: (current?.policy_version ?? 0) + 1,
      credential_version: version, encrypted_credential: encrypted, catalog,
      capabilities: connectionPolicies,
      catalog_updated_at: now, verified_at: now, consent_at: now, updated_at: now };
    return connectionDto(await publishConnection(input.siteId, actorId, input.expectedRevision, candidate));
  }
  if (!current || current.status !== 'connected') throw new OpenRouterError('not_connected', 'Connect an OpenRouter account first', 409);
  if (input.operation === 'recommend') {
    const { recommendModels } = await import('./recommend');
    return connectionDto(await recommendModels(current, actorId, input));
  }
  if (input.operation === 'verify') {
    const { verifyImage } = await import('./verify');
    return connectionDto(await verifyImage(current, actorId, input));
  }
  if(input.operation==='recover_verification'){
    const {recoverImageVerification}=await import('./recover-verification');
    return connectionDto(await recoverImageVerification(current,actorId,input.operationId));
  }
  if (input.operation === 'disconnect') {
    return connectionDto(await publishConnection(input.siteId, actorId, input.expectedRevision, { ...current,
      status: 'disconnected', selected: false, encrypted_credential: null, credential_version: current.credential_version + 1,
      catalog: [], capabilities: emptyCapabilities(), consent_at: null, verified_at: null, catalog_updated_at: null }));
  }
  if (input.operation === 'refresh') {
    const token = randomUUID();
    await claimRefresh(input.siteId, actorId, input.expectedRevision, token);
    try {
      const catalog = await discoverCatalog(decryptCredential(current.encrypted_credential!, input.siteId, current.id, current.credential_version));
      const refreshedPolicies=evaluateCapabilities(current.capabilities,catalog);
      const issue=combinedChatPolicyIssue(refreshedPolicies,catalog);
      if(issue)throw new OpenRouterError('combined_capability_unsupported',issue,422);
      return connectionDto(await publishConnection(input.siteId, actorId, input.expectedRevision, { ...current, catalog,
        capabilities: refreshedPolicies, catalog_updated_at: new Date().toISOString() }, token));
    } finally { await releaseRefresh(input.siteId, token).catch(() => undefined); }
  }
  const capabilities = structuredClone(current.capabilities);
  for (const [key, patch] of Object.entries(input.capabilities ?? {})) {
    if (!patch) continue;
    const capability = key as keyof typeof capabilities;
    if (patch.mode === 'automatic' && (capability === 'embedding' || !capabilities[capability].recommendation)) {
      throw new OpenRouterError('recommendation_required', 'Generate a recommendation before enabling automatic routing. Embeddings require an explicit index binding.', 422);
    }
    const modelId = patch.modelId === undefined ? capabilities[capability].modelId : patch.modelId;
    if (patch.mode === 'manual' && (!modelId || (!current.catalog.some(model => model.id === modelId) && modelId !== capabilities[capability].modelId))) {
      throw new OpenRouterError('invalid_model', 'Choose an exact model from this account catalog', 422);
    }
    capabilities[capability] = { ...capabilities[capability], mode: patch.mode, modelId,
      ...(patch.embeddingDimensions !== undefined && capability === 'embedding' ? { embeddingDimensions: patch.embeddingDimensions } : {}) };
  }
  const evaluated = evaluateCapabilities(capabilities,current.catalog);
  const issue = combinedChatPolicyIssue(evaluated,current.catalog);
  if (issue) throw new OpenRouterError('combined_capability_unsupported',issue,422);
  if (input.selected === true && !Object.values(evaluated).some(policy => policy.mode !== 'disabled' && ['available','unverified'].includes(policy.status))) {
    throw new OpenRouterError('no_ready_capability','Configure a compatible capability before selecting this connection',422);
  }
  return connectionDto(await publishConnection(input.siteId, actorId, input.expectedRevision, {
    ...current, capabilities: evaluated, selected: input.selected ?? current.selected,
  }));
}
