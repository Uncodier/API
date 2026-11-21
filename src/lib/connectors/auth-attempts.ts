import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getConnectorProvider, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { prepareConnectorProvider, readProviderBinding } from './provider-binding';
import { ConnectorError } from './types';
import { createComposioClient } from './composio-transport';
import { createAuthLink, completeAuth, verifyAccountIdentity } from './composio-accounts';
import { listAuthConfigs } from './composio-catalog';

const uuid = z.string().uuid();
const nonceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const attemptColumns = 'id,site_id,provider_id,user_id,toolkit_slug,auth_config_id,provider_account_id,nonce_hash,credential_revision,status,expires_at,connector_id';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const signal = () => AbortSignal.timeout(5_000);

type AuthAttempt = {
  id: string; site_id: string; provider_id: string; user_id: string;
  toolkit_slug: string; auth_config_id: string; provider_account_id: string | null;
  nonce_hash: string; credential_revision: string; status: string; expires_at: string;
  connector_id: string | null;
};

export async function getAuthAttempt(siteId: string, userId: string, attemptId: string): Promise<AuthAttempt> {
  uuid.parse(attemptId);
  await requireConnectorSiteAccess(siteId, userId, true);
  const { data, error } = await supabaseAdmin.from('site_connector_auth_attempts').select(attemptColumns)
    .eq('site_id', siteId).eq('id', attemptId).eq('user_id', userId).abortSignal(signal()).maybeSingle();
  if (error) connectorDatabaseError(error);
  if (!data) throw new ConnectorError('NOT_FOUND', 'Authentication attempt not found.', 404);
  return data as AuthAttempt;
}

async function setUnknown(attemptId: string, previous: string) {
  await supabaseAdmin.from('site_connector_auth_attempts').update({ status: 'outcome_unknown' })
    .eq('id', attemptId).eq('status', previous).abortSignal(signal());
}

export async function startConnectorAuth(input: { siteId: string; userId: string; toolkitSlug: string; authConfigId: string; nonce: string }) {
  nonceSchema.parse(input.nonce);
  const { provider, credential, callbackUrl } = await prepareConnectorProvider(input.siteId, input.userId);
  const client = createComposioClient(credential.apiKey);
  let configFound = false;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const configs = await listAuthConfigs(client, input.toolkitSlug, cursor);
    configFound = configs.items.some(config => config.id === input.authConfigId && config.authScheme === 'OAUTH2' && config.status === 'ENABLED');
    if (configFound || !configs.next_cursor) break;
    cursor = configs.next_cursor;
  }
  if (!configFound) {
    throw new ConnectorError('AUTH_CONFIG_UNAVAILABLE', 'Select an enabled OAuth configuration for this toolkit.', 422);
  }
  const insert = await supabaseAdmin.from('site_connector_auth_attempts').insert({
    site_id: input.siteId, provider_id: provider.id, user_id: input.userId,
    toolkit_slug: input.toolkitSlug, auth_config_id: input.authConfigId,
    nonce_hash: hash(input.nonce), credential_revision: credential.revision, status: 'pending',
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  }).select('id,expires_at').abortSignal(signal()).single();
  if (insert.error) connectorDatabaseError(insert.error);
  const id = insert.data.id as string;
  try {
    const link = await createAuthLink(client, { authConfigId: input.authConfigId, userId: provider.provider_user_id, callbackUrl });
    const expiresAt = new Date(Math.min(Date.parse(insert.data.expires_at), Date.parse(link.expiresAt))).toISOString();
    const saved = await supabaseAdmin.from('site_connector_auth_attempts')
      .update({ provider_account_id: link.accountId, expires_at: expiresAt }).eq('id', id)
      .eq('status', 'pending').select('id').abortSignal(signal()).single();
    if (saved.error) connectorDatabaseError(saved.error);
    return { attempt_id: id, redirect_url: link.redirectUrl };
  } catch (error) {
    await setUnknown(id, 'pending');
    throw error;
  }
}

export async function finishConnectorAuth(input: { siteId: string; userId: string; attemptId: string; nonce: string; sessionUri: string }) {
  nonceSchema.parse(input.nonce);
  const attempt = await getAuthAttempt(input.siteId, input.userId, input.attemptId);
  const expected = Buffer.from(attempt.nonce_hash, 'hex');
  const received = Buffer.from(hash(input.nonce), 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new ConnectorError('ACCESS_DENIED', 'Authentication proof does not match this attempt.', 403);
  // A completed attempt is a receipt, not authority for a different callback proof.
  // Read its status separately; do not report the old account as a new OAuth success.
  if (attempt.status === 'completed') throw new ConnectorError('AUTH_ATTEMPT_COMPLETED', 'This authentication attempt was already completed. Review the existing connection.', 409);
  if (attempt.status !== 'pending' || !attempt.provider_account_id || Date.parse(attempt.expires_at) <= Date.now()) {
    throw new ConnectorError('AUTH_ATTEMPT_UNAVAILABLE', 'This attempt expired or has an unconfirmed outcome. Start a new connection.', 409);
  }
  const credential = await loadConnectorCredential(input.siteId);
  const provider = await getConnectorProvider(input.siteId, attempt.provider_id);
  const binding = await readProviderBinding(input.siteId, credential.revision);
  if (!provider || provider.status !== 'active' || provider.project_id !== binding.projectId ||
    provider.credential_revision !== credential.revision || attempt.credential_revision !== credential.revision) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Provider configuration changed during authentication.', 409);
  }
  const claim = await supabaseAdmin.from('site_connector_auth_attempts').update({ status: 'completing' })
    .eq('id', attempt.id).eq('status', 'pending').select('id').abortSignal(signal()).maybeSingle();
  if (claim.error) connectorDatabaseError(claim.error);
  if (!claim.data) throw new ConnectorError('AUTH_ATTEMPT_BUSY', 'This attempt is already being completed.', 409);
  try {
    const client = createComposioClient(credential.apiKey);
    const completed = await completeAuth(client, { sessionUri: input.sessionUri, userId: provider.provider_user_id });
    if (completed.accountId !== attempt.provider_account_id || completed.toolkitSlug !== attempt.toolkit_slug) {
      throw new ConnectorError('AUTH_ACCOUNT_MISMATCH', 'The returned account does not match this authentication attempt.', 409);
    }
    const account = await verifyAccountIdentity(client, {
      accountId: completed.accountId, userId: provider.provider_user_id,
      toolkitSlug: attempt.toolkit_slug, authConfigId: attempt.auth_config_id,
    });
    await requireConnectorSiteAccess(input.siteId, input.userId, true);
    if ((await loadConnectorCredential(input.siteId)).revision !== credential.revision ||
      (await readProviderBinding(input.siteId, credential.revision)).projectId !== provider.project_id) {
      throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'The provider binding changed while authentication was being verified.', 409);
    }
    const finalized = await supabaseAdmin.rpc('connector_finalize_auth', {
      p_attempt_id: attempt.id, p_actor_id: input.userId, p_nonce_hash: attempt.nonce_hash,
      p_provider_account_id: account.id, p_toolkit_slug: account.toolkitSlug,
      p_auth_config_id: account.authConfigId, p_display_name: account.name || attempt.toolkit_slug,
      p_granted_scopes: account.scopes,
    }).abortSignal(signal());
    if (finalized.error) connectorDatabaseError(finalized.error);
    return { connector_id: finalized.data.id as string, toolkit_slug: attempt.toolkit_slug, status: 'completed' as const };
  } catch (error) {
    // Single-use provider proof may already have been consumed. Never auto-replay it.
    await setUnknown(attempt.id, 'completing');
    throw error;
  }
}