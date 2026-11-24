import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getConnectorProvider, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { prepareConnectorProvider, readProviderBinding } from './provider-binding';
import { ConnectorError } from './types';
import { createComposioClient } from './composio-transport';
import { createAuthLink, completeAuth, verifyAccountIdentity } from './composio-accounts';
import { getToolkit, listAuthConfigs } from './composio-catalog';
import { readAuthConfigs, resolveHostedAuthConfig } from './auth-config-provisioning';
import { canUseHostedConfig, isHostedCredentialScheme } from './connection-onboarding';

const uuid = z.string().uuid();
const nonceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const attemptColumns = 'id,site_id,provider_id,user_id,toolkit_slug,auth_config_id,provider_account_id,nonce_hash,credential_revision,status,created_at,expires_at,connector_id,ask_on_connect';
const credentialAttemptColumns = `${attemptColumns},setup_mode` as const;
type SetupMode = 'legacy' | 'hosted' | 'hosted_credentials';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const signal = () => AbortSignal.timeout(5_000);

type AuthAttempt = {
  id: string; site_id: string; provider_id: string; user_id: string;
  toolkit_slug: string; auth_config_id: string; provider_account_id: string | null;
  nonce_hash: string; credential_revision: string; status: string; created_at: string; expires_at: string;
  connector_id: string | null; ask_on_connect?: boolean; setup_mode?: SetupMode;
};

export async function getAuthAttempt(siteId: string, userId: string, attemptId: string): Promise<AuthAttempt> {
  uuid.parse(attemptId);
  await requireConnectorSiteAccess(siteId, userId, true);
  const query = supabaseAdmin.from('site_connector_auth_attempts').select(credentialAttemptColumns);
  const { data, error } = await query.eq('site_id', siteId).eq('id', attemptId).eq('user_id', userId).abortSignal(signal()).maybeSingle();
  if (error) connectorDatabaseError(error);
  if (!data) throw new ConnectorError('NOT_FOUND', 'Authentication attempt not found.', 404);
  return data as AuthAttempt;
}

async function setUnknown(attemptId: string, previous: string) {
  await supabaseAdmin.from('site_connector_auth_attempts').update({ status: 'outcome_unknown' })
    .eq('id', attemptId).eq('status', previous).abortSignal(signal());
}

type AuthStartScope = { siteId: string; userId: string; toolkitSlug: string; nonce: string };
type AuthStart = AuthStartScope & ({ authConfigId: string; askOnConnect?: true; hosted?: never }
  | { authConfigId?: string; askOnConnect?: never; expectedSetup: string; hosted: true });

async function requireLegacyAuthConfig(client: ReturnType<typeof createComposioClient>, input: AuthStart & { authConfigId: string }) {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const configs = await listAuthConfigs(client, input.toolkitSlug, cursor);
    if (configs.items.some(config => config.id === input.authConfigId && (config.authScheme === 'OAUTH2' || (input.askOnConnect && config.authScheme === 'API_KEY' && input.toolkitSlug !== 'supabase')) && config.status === 'ENABLED')) return input.authConfigId;
    if (!configs.next_cursor) break;
    cursor = configs.next_cursor;
  }
  throw new ConnectorError('AUTH_CONFIG_UNAVAILABLE', 'Select an enabled, supported authentication configuration for this toolkit.', 422);
}

export async function startConnectorAuth(input: AuthStart) {
  nonceSchema.parse(input.nonce);
  const { provider, credential, callbackUrl } = await prepareConnectorProvider(input.siteId, input.userId);
  const requireCurrentBinding = async () => {
    await requireConnectorSiteAccess(input.siteId, input.userId, true);
    const selectedCredential = await loadConnectorCredential(input.siteId);
    const current = selectedCredential.revision === credential.revision && await readProviderBinding(input.siteId, credential.revision);
    if (!current || current.projectId !== provider.project_id || current.callbackUrl !== callbackUrl) {
      throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'The provider binding changed during connection setup.', 409);
    }
  };
  const client = createComposioClient(credential.apiKey);
  let authConfigId: string;
  let setupMode: SetupMode = 'legacy';
  if (input.hosted) {
    const [toolkit, configs] = await Promise.all([getToolkit(client, input.toolkitSlug), readAuthConfigs(client, input.toolkitSlug, true)]);
    const config = await resolveHostedAuthConfig(client, provider.project_id, toolkit, configs, input.authConfigId, { key: input.expectedSetup, revision: credential.revision }, requireCurrentBinding);
    authConfigId = config.id;
    setupMode = isHostedCredentialScheme(config.authScheme) ? 'hosted_credentials' : 'hosted';
    await requireCurrentBinding();
  } else {
    authConfigId = await requireLegacyAuthConfig(client, input);
  }
  const insert = await supabaseAdmin.from('site_connector_auth_attempts').insert({
    site_id: input.siteId, provider_id: provider.id, user_id: input.userId,
    toolkit_slug: input.toolkitSlug, auth_config_id: authConfigId,
    nonce_hash: hash(input.nonce), credential_revision: credential.revision, status: 'pending',
    ...(input.askOnConnect===true && {ask_on_connect:true}),
    ...(input.hosted && { setup_mode: setupMode }),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  }).select('id,expires_at').abortSignal(signal()).single();
  if (insert.error) connectorDatabaseError(insert.error);
  const id = insert.data.id as string;
  try {
    const callback = new URL(callbackUrl);
    if (setupMode === 'hosted_credentials') callback.searchParams.set('credential_attempt', id);
    const link = await createAuthLink(client, { authConfigId, userId: provider.provider_user_id, callbackUrl: callback.toString(),
      ...(input.hosted && { privateAccount: true as const }), });
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

type AuthCompletion = { siteId: string; userId: string; attemptId: string; nonce: string } &
  ({ sessionUri: string; continuation: string; hostedCredential?: never } | { sessionUri?: never; hostedCredential: true });

async function prepareCompletion(input: AuthCompletion) {
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
  if (input.hostedCredential ? attempt.setup_mode !== 'hosted_credentials' : !['legacy', 'hosted'].includes(attempt.setup_mode ?? '')) {
    throw new ConnectorError('ACCESS_DENIED', 'Authentication method does not match this attempt.', 403);
  }
  if (!input.hostedCredential) {
    // Issued to the initiating tab, separate from the HttpOnly cookie. An id
    // from a callback URL or another tab's cookie is not enough to spend proof.
    const tag = createHmac('sha256', input.nonce).update(`connector-tab:v1:${attempt.id}`).digest();
    const supplied = Buffer.from(nonceSchema.parse(input.continuation), 'hex');
    if (!timingSafeEqual(tag, supplied)) throw new ConnectorError('ACCESS_DENIED', 'Callback does not match the originating tab.', 403);
    // complete_auth only distinguishes project + provider user. Check all
    // actors/configs (including unknown outcomes) before the single-use write.
    const others = await supabaseAdmin.from('site_connector_auth_attempts').select('id')
      .eq('site_id', attempt.site_id).neq('id', attempt.id).neq('setup_mode', 'hosted_credentials')
      .neq('status', 'completed').gte('expires_at', attempt.created_at).limit(1).abortSignal(signal());
    if (others.error) connectorDatabaseError(others.error);
    if (!Array.isArray(others.data) || others.data.length) throw new ConnectorError('AUTH_ATTEMPT_AMBIGUOUS', 'Another authorization could own this callback. Start again after pending attempts expire.', 409);
  }
  const credential = await loadConnectorCredential(input.siteId);
  const provider = await getConnectorProvider(input.siteId, attempt.provider_id);
  const binding = await readProviderBinding(input.siteId, credential.revision);
  if (!provider || provider.provider_user_id !== input.siteId || provider.status !== 'active' || provider.project_id !== binding.projectId ||
    provider.credential_revision !== credential.revision || attempt.credential_revision !== credential.revision) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Provider configuration changed during authentication.', 409);
  }
  const client = createComposioClient(credential.apiKey);
  const identity = { accountId: attempt.provider_account_id, userId: provider.provider_user_id,
    toolkitSlug: attempt.toolkit_slug, authConfigId: attempt.auth_config_id };
  let credentialAccount: Awaited<ReturnType<typeof verifyAccountIdentity>> | undefined;
  let hostedScheme: string | null = null;
  if (attempt.setup_mode !== 'legacy') {
    const [toolkit, configs] = await Promise.all([getToolkit(client, attempt.toolkit_slug), readAuthConfigs(client, attempt.toolkit_slug, true)]);
    const config = configs.find(item => item.id === attempt.auth_config_id && canUseHostedConfig(toolkit, item) &&
      isHostedCredentialScheme(item.authScheme) === (input.hostedCredential === true));
    if (!config?.authScheme) throw new ConnectorError('AUTH_CONFIG_UNAVAILABLE', 'This authentication configuration is no longer eligible.', 422);
    hostedScheme = config.authScheme;
  }
  if (input.hostedCredential) {
    // Ignore callback status and account IDs. The exact account issued before
    // redirect must now be active under the same project and provider user.
    // A pending account leaves the attempt unclaimed for an explicit status check.
    credentialAccount = await verifyAccountIdentity(client, identity);
    if (credentialAccount.authScheme !== hostedScheme || credentialAccount.accountType !== 'PRIVATE') {
      throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'The provider account authentication method could not be verified.', 409);
    }
  }
  return { attempt, credential, provider, client, identity, credentialAccount, hostedScheme };
}

export async function finishConnectorAuth(input: AuthCompletion) {
  // Only reads happen here. Never classify a failed claim, finalizer, or
  // response transport as a safe credential status check.
  const { attempt, credential, provider, client, identity, credentialAccount, hostedScheme } = await prepareCompletion(input).catch(error => {
    if (input.hostedCredential && error instanceof ConnectorError &&
      ['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'STORAGE_UNAVAILABLE'].includes(error.code)) {
      throw new ConnectorError('CREDENTIAL_CHECK_UNAVAILABLE', 'The account check is temporarily unavailable. Check again.', 503);
    }
    throw error;
  });
  const claim = await supabaseAdmin.from('site_connector_auth_attempts').update({ status: 'completing' })
    .eq('id', attempt.id).eq('nonce_hash', attempt.nonce_hash).eq('status', 'pending').gt('expires_at', new Date().toISOString()).select('id').abortSignal(signal()).maybeSingle();
  if (claim.error) connectorDatabaseError(claim.error);
  if (!claim.data) throw new ConnectorError('AUTH_ATTEMPT_BUSY', 'This attempt is already being completed.', 409);
  try {
    let account = credentialAccount;
    if (!account) {
      if (input.hostedCredential) throw new ConnectorError('AUTH_ACCOUNT_MISMATCH', 'The provider did not verify a connected account.', 409);
      const completed = await completeAuth(client, { sessionUri: input.sessionUri, userId: provider.provider_user_id });
      if (completed.accountId !== identity.accountId || completed.toolkitSlug !== identity.toolkitSlug) {
        throw new ConnectorError('AUTH_ACCOUNT_MISMATCH', 'The returned account does not match this authentication attempt.', 409);
      }
      account = await verifyAccountIdentity(client, identity);
      if (attempt.setup_mode === 'hosted' && (account.authScheme !== hostedScheme || account.accountType !== 'PRIVATE')) {
        throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'Private OAuth account identity could not be verified.', 409);
      }
    }
    // The site manager delegated this exact private downstream account during hosted OAuth.
    // The platform Composio key authenticates transport; it is not the downstream credential.
    const scheme=account.oauth2 ? 'OAUTH2' : account.apiKeyAuth ? 'API_KEY' : null;
    const toolkit = !input.hostedCredential && attempt.ask_on_connect === true && account.accountType === 'PRIVATE' && scheme && attempt.toolkit_slug!=='supabase'
      ? await getToolkit(client, account.toolkitSlug) : null;
    const delegated = toolkit?.type === 'native' && toolkit.toolkit_type === 'api' && toolkit.enabled !== false;
    await requireConnectorSiteAccess(input.siteId, input.userId, true);
    if ((await loadConnectorCredential(input.siteId)).revision !== credential.revision ||
      (await readProviderBinding(input.siteId, credential.revision)).projectId !== provider.project_id) {
      throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'The provider binding changed while authentication was being verified.', 409);
    }
    const finalized = await supabaseAdmin.rpc(delegated ? 'connector_finalize_customer_account' : 'connector_finalize_auth', {
      p_attempt_id: attempt.id, p_actor_id: input.userId, p_nonce_hash: attempt.nonce_hash,
      p_provider_account_id: account.id, p_toolkit_slug: account.toolkitSlug,
      p_auth_config_id: account.authConfigId, p_display_name: account.name || attempt.toolkit_slug,
      p_granted_scopes: account.scopes, ...(delegated && {p_auth_scheme:scheme}),
    }).abortSignal(signal());
    if (finalized.error) connectorDatabaseError(finalized.error);
    return { connector_id: finalized.data.id as string, toolkit_slug: attempt.toolkit_slug, status: 'completed' as const };
  } catch (error) {
    // Single-use provider proof may already have been consumed. Never auto-replay it.
    await setUnknown(attempt.id, 'completing');
    throw error;
  }
}