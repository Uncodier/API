import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { verifyAccountIdentity } from './composio-accounts';
import { createComposioClient } from './composio-transport';
import { providerId, providerValue } from './composio-validation';
import { ensureSupabaseTokenConfig } from './managed-oauth';
import { prepareConnectorTokenProvider, readTokenProviderBinding } from './provider-binding';
import { ConnectorError } from './types';

export const supabaseTokenInput = z.object({
  site_id: z.string().uuid(), project_ref: z.string().regex(/^[a-z0-9]{20}$/),
  token: z.string().min(24).max(512).regex(/^sbp_[A-Za-z0-9_-]+$/),
}).strict();
const slug = 'supabase';
const managementOrigin = 'https://api.supabase.com';
const signal = () => AbortSignal.timeout(5_000);

async function verifyToken(project: string, token: string) {
  let response: Response;
  try {
    response = await fetch(`${managementOrigin}/v1/projects/${project}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error', signal: signal(),
    });
  } catch {
    throw new ConnectorError('SUPABASE_TOKEN_CHECK_UNAVAILABLE', 'Supabase token verification is unavailable.', 503);
  }
  void response.body?.cancel().catch(() => undefined);
  if ([401, 403, 404].includes(response.status)) {
    throw new ConnectorError('SUPABASE_TOKEN_REJECTED', 'The token could not read the specified project.', 422);
  }
  if (response.status !== 200) throw new ConnectorError('SUPABASE_TOKEN_CHECK_UNAVAILABLE', 'Supabase token verification is unavailable.', 503);
}

export async function connectSupabaseToken(input: z.infer<typeof supabaseTokenInput>, actor: string) {
  const { site_id: site, project_ref: project, token } = supabaseTokenInput.parse(input);
  const { provider, credential } = await prepareConnectorTokenProvider(site, actor);
  await verifyToken(project, token);
  const client = createComposioClient(credential.apiKey);
  const config = await ensureSupabaseTokenConfig(client, provider.project_id);
  const nonceHash = createHash('sha256').update(randomBytes(32)).digest('hex');
  const pending = await supabaseAdmin.from('site_connector_auth_attempts').insert({
    site_id: site, provider_id: provider.id, user_id: actor, toolkit_slug: slug,
    supabase_project_ref: project, auth_config_id: config, nonce_hash: nonceHash, credential_revision: credential.revision,
    status: 'pending', expires_at: new Date(Date.now() + 600_000).toISOString(),
  }).select('id').abortSignal(signal()).single();
  if (pending.error) connectorDatabaseError(pending.error);
  const id = pending.data.id as string;
  let status = 'pending';
  let providerCreated = false;
  try {
    const created = providerValue(z.object({ id: providerId }), await client.request('/connected_accounts', {
      method: 'POST', body: { auth_config: { id: config }, connection: {
        user_id: provider.provider_user_id, alias: `Makinari Supabase ${project} ${id}`,
        state: { authScheme: 'API_KEY', val: { status: 'ACTIVE', full: managementOrigin, bearer_token: token } },
      } },
    }), true);
    providerCreated = true;
    const saved = await supabaseAdmin.from('site_connector_auth_attempts').update({ provider_account_id: created.id })
      .eq('id', id).eq('status', 'pending').select('id').abortSignal(signal()).single();
    if (saved.error) connectorDatabaseError(saved.error);
    await verifyAccountIdentity(client, { accountId: created.id, userId: provider.provider_user_id, toolkitSlug: slug, authConfigId: config });
    await requireConnectorSiteAccess(site, actor, true);
    if ((await loadConnectorCredential(site)).revision !== credential.revision ||
      (await readTokenProviderBinding(site, credential.revision)).projectId !== provider.project_id) throw new Error('Provider binding changed');
    const claim = await supabaseAdmin.from('site_connector_auth_attempts').update({ status: 'completing' })
      .eq('id', id).eq('status', 'pending').select('id').abortSignal(signal()).single();
    if (claim.error) connectorDatabaseError(claim.error);
    status = 'completing';
    const finalized = await supabaseAdmin.rpc('connector_finalize_auth', {
      p_attempt_id: id, p_actor_id: actor, p_nonce_hash: nonceHash, p_provider_account_id: created.id,
      p_toolkit_slug: slug, p_auth_config_id: config, p_display_name: `Supabase · ${project}`, p_granted_scopes: [],
    }).abortSignal(signal());
    if (finalized.error) connectorDatabaseError(finalized.error);
    return { status: 'completed' as const, connector_id: finalized.data.id as string };
  } catch (error) {
    const rejected = !providerCreated && error instanceof ConnectorError && ['PROVIDER_AUTH_FAILED', 'PROVIDER_FORBIDDEN', 'PROVIDER_REJECTED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_NOT_FOUND'].includes(error.code);
    try {
      await supabaseAdmin.from('site_connector_auth_attempts').update({ status: rejected ? 'failed' : 'outcome_unknown' })
        .eq('id', id).eq('status', status).abortSignal(signal());
    } catch { /* Do not expose transport errors or retry the provider write. */ }
    if (rejected) throw error;
    throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'The connection outcome is unknown. Refresh before retrying.', 502);
  }
}