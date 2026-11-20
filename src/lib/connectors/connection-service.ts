import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  connectorDatabaseError, getConnectorProvider, getVisibleConnector, listVisibleConnectors,
  loadConnectorCredential, requireConnectorSiteAccess,
} from './access';
import { getAccount, listAccounts, revokeAccount, type ComposioAccount } from './composio-accounts';
import { createComposioClient, type ComposioClient } from './composio-transport';
import { readProviderBinding, readTokenProviderBinding } from './provider-binding';
import { ConnectorError, connectorAccessMode, type Connector, type ConnectorMemberGrant, type ConnectorProvider } from './types';
import { effectiveMemberGrant } from './grant-resolution';

const uuid = z.string().uuid();
export const revisionBodySchema = z.object({
  site_id: uuid, expected_revision: z.number().int().min(1).max(2_147_483_646),
}).strict();

export async function projectConnections(siteId: string, userId: string, connectors: Connector[]) {
  const access = await requireConnectorSiteAccess(siteId, userId);
  if (!connectors.length) return [];
  if (connectors.length > 1000) throw new ConnectorError('ACCESS_LIMIT', 'Too many connector grants for this request.', 422);
  const grants = new Map<string, ConnectorMemberGrant>();
  // Bound filter URL size even when the connector list reaches its cap.
  for (let offset = 0; offset < connectors.length; offset += 100) {
    const ids = connectors.slice(offset, offset + 100).map(row => row.id);
    const { data, error, count } = await supabaseAdmin.from('connector_members')
      .select('connector_id,user_id,can_view,can_use,expires_at,revoked_at', { count: 'exact' }).eq('site_id', siteId)
      .eq('user_id', userId).in('connector_id', ids).abortSignal(AbortSignal.timeout(5_000));
    if (error) connectorDatabaseError(error);
    // A truncated response must never turn an explicit denial into a missing row.
    if (!Array.isArray(data) || count !== data.length || count > ids.length) connectorDatabaseError(null);
    for (const row of data as (ConnectorMemberGrant & { connector_id: string })[]) grants.set(row.connector_id, row);
  }
  return connectors.flatMap(connector => {
    const own = effectiveMemberGrant(connector, grants.get(connector.id) ?? null);
    if (!access.can_manage && !own.can_view) return [];
    return [{
      id: connector.id, toolkit_slug: connector.toolkit_slug, display_name: connector.display_name,
      access_mode: connectorAccessMode(connector),
      provider_status: connector.provider_status, enabled: connector.enabled, revocation_pending: connector.revocation_pending,
      revocation_dispatched: connector.revocation_dispatched ?? connector.revocation_pending,
      revision: connector.revision, verified_at: connector.verified_at,
      ...(access.can_manage && connector.toolkit_slug === 'supabase' && connector.supabase_project_ref === null
        && connector.enabled && connector.verified_at && connector.provider_status === 'ACTIVE' && !connector.revocation_pending
        ? { can_verify_supabase_project: true } : {}),
      // Effective human permission, not an execution claim or management bypass.
      can_use: own.can_use,
    }];
  });
}

/** Local-only account summary; never enumerate another account or synchronize with the provider. */
export async function getConnectionSummary(siteId: string, userId: string, id: string) {
  const connector = await getVisibleConnector(siteId, userId, id);
  const [summary] = await projectConnections(siteId, userId, [connector]);
  if (!summary || summary.id !== id) throw new ConnectorError('NOT_FOUND', 'Connector not found.', 404);
  return summary;
}

export async function listConnections(siteId: string, userId: string) {
  uuid.parse(siteId);
  const access = await requireConnectorSiteAccess(siteId, userId);
  const connectors = await listVisibleConnectors(siteId, userId);
  return { items: await projectConnections(siteId, userId, connectors), can_manage: access.can_manage };
}

export async function manageable(siteId: string, userId: string, id: string, revision: number) {
  revisionBodySchema.parse({ site_id: siteId, expected_revision: revision }); uuid.parse(id);
  await requireConnectorSiteAccess(siteId, userId, true);
  const connector = await getVisibleConnector(siteId, userId, id);
  if (connector.revision !== revision) throw new ConnectorError('REVISION_CONFLICT', 'Configuration changed. Reload before trying again.', 409);
  return connector;
}

export async function providerClient(connector: Connector) {
  const credential = await loadConnectorCredential(connector.site_id);
  const binding = (connector.toolkit_slug === 'supabase' ? readTokenProviderBinding : readProviderBinding)(connector.site_id, credential.revision);
  const provider = await getConnectorProvider(connector.site_id, connector.provider_id);
  if (!provider || provider.id !== connector.provider_id || provider.site_id !== connector.site_id
    || provider.status !== 'active' || provider.credential_revision !== credential.revision
    || provider.project_id !== binding.projectId || provider.project_id !== connector.provider_project_id
    || provider.provider_user_id !== connector.site_id) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Verify the existing connector provider configuration before continuing.', 409);
  }
  return { client: createComposioClient(credential.apiKey), provider };
}

async function exactAccount(client: ComposioClient, provider: ConnectorProvider, connector: Connector): Promise<ComposioAccount> {
  let account = await getAccount(client, connector.provider_account_id);
  const matches = (row: ComposioAccount) => row.id === connector.provider_account_id
    && row.toolkitSlug === connector.toolkit_slug && row.authConfigId === connector.auth_config_id
    && row.accountType !== 'SHARED' && (row.userId === undefined || row.userId === provider.provider_user_id);
  if (!matches(account)) throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'The provider account identity could not be verified.', 409);
  if (account.userId === undefined) {
    // Missing deprecated owner fields need a filtered provider proof, not an inferred tenant.
    let cursor: string | undefined;
    let found = false;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await listAccounts(client, provider.provider_user_id, cursor);
      const owned = page.items.find(row => row.id === connector.provider_account_id);
      if (owned) {
        if (!matches(owned)) throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'The provider account identity could not be verified.', 409);
        account = owned; found = true; break;
      }
      if (!page.next_cursor || seen.has(page.next_cursor)) break;
      seen.add(page.next_cursor); cursor = page.next_cursor;
    }
    if (!found) throw new ConnectorError('SYNC_INCOMPLETE', 'The account was not verified in the bounded provider result. No missing account was marked revoked.', 409);
  }
  return account;
}

type State = { status: string; pending: boolean; verified: boolean; scopes: string[]; credentialRevision?: string };
async function setProviderState(connector: Connector, userId: string, state: State): Promise<Connector> {
  const { data, error } = await supabaseAdmin.rpc('connector_set_provider_state', {
    p_site_id: connector.site_id, p_connector_id: connector.id, p_actor_id: userId,
    p_expected_revision: connector.revision, p_provider_status: state.status,
    p_revocation_pending: state.pending, p_verified: state.verified, p_granted_scopes: state.scopes,
    p_credential_revision: state.credentialRevision ?? null,
  }).abortSignal(AbortSignal.timeout(5_000));
  if (error) connectorDatabaseError(error);
  if (!data || data.id !== connector.id || data.site_id !== connector.site_id || data.revision !== connector.revision + 1
    || data.provider_status !== state.status || data.revocation_pending !== state.pending
    || ((state.status !== 'ACTIVE' || state.pending) && data.enabled !== false)) {
    throw new ConnectorError('STORAGE_UNAVAILABLE', 'The connector state change could not be confirmed. Reload before retrying.', 503);
  }
  return data as Connector;
}

export async function syncConnector(siteId: string, userId: string, id: string, revision: number) {
  const connector = await manageable(siteId, userId, id, revision);
  const { client, provider } = await providerClient(connector);
  const account = await exactAccount(client, provider, connector);
  // Recheck credential revision after I/O. Sync never creates/adopts accounts or reenables one.
  if ((await loadConnectorCredential(siteId)).revision !== provider.credential_revision) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'The provider credential changed during synchronization.', 409);
  }
  const status = (account.authConfigDisabled || account.disabled) && account.status === 'ACTIVE' ? 'DISABLED' : account.status;
  const updated = await setProviderState(connector, userId, {
    status, pending: status === 'REVOKED' ? false : connector.revocation_pending,
    verified: true, scopes: status === 'ACTIVE' ? account.scopes : [], credentialRevision: provider.credential_revision,
  });
  return { connector_id: id, revision: updated.revision, connection: (await projectConnections(siteId, userId, [updated]))[0] };
}

export async function disconnectConnector(siteId: string, userId: string, id: string, revision: number) {
  const connector = await manageable(siteId, userId, id, revision);
  if ((connector.revocation_pending && connector.revocation_dispatched !== false) || connector.provider_status === 'REVOKED') {
    throw new ConnectorError('REVOCATION_RECONCILIATION_REQUIRED', 'This disconnect has already started. Synchronize its state instead of repeating the provider write.', 409);
  }
  // Disable durably first, even if credentials/provider access subsequently fail.
  const disabled = connector.revocation_pending ? connector : await setProviderState(connector, userId, {
    status: connector.provider_status, pending: true, verified: false, scopes: connector.granted_scopes,
  });
  const { client, provider } = await providerClient(disabled);
  const account = await exactAccount(client, provider, disabled);
  await requireConnectorSiteAccess(siteId, userId, true);
  const current = await getVisibleConnector(siteId, userId, id);
  if (current.revision !== disabled.revision || !current.revocation_pending) {
    throw new ConnectorError('REVISION_CONFLICT', 'Connector state changed before provider revocation. Synchronize before continuing.', 409);
  }
  if ((await loadConnectorCredential(siteId)).revision !== provider.credential_revision) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'The provider credential changed before revocation.', 409);
  }
  let completionBase = disabled;
  if (account.status !== 'REVOKED') {
    // Claim durably only immediately before dispatch. Preflight failures remain
    // explicitly retryable; lost dispatch results do not allow another write.
    const claim = await supabaseAdmin.rpc('connector_claim_revocation', {
      p_site_id: siteId, p_connector_id: id, p_actor_id: userId,
      p_expected_revision: disabled.revision, p_credential_revision: provider.credential_revision,
    }).abortSignal(AbortSignal.timeout(5_000));
    if (claim.error) connectorDatabaseError(claim.error);
    if (!claim.data || claim.data.id !== id || claim.data.revision !== disabled.revision + 1 || claim.data.revocation_dispatched !== true) {
      throw new ConnectorError('STORAGE_UNAVAILABLE', 'The revocation dispatch claim could not be confirmed.', 503);
    }
    completionBase = claim.data as Connector;
    await revokeAccount(client, connector.provider_account_id);
  }
  let updated;
  try {
    updated = await setProviderState(completionBase, userId, {
      status: 'REVOKED', pending: false, verified: true, scopes: [], credentialRevision: provider.credential_revision,
    });
  } catch {
    // The external write may have completed; never turn an unconfirmed receipt into success or retry.
    throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'Provider revocation was confirmed but local completion was not. Synchronize before taking another action.', 502);
  }
  return { connector_id: id, revision: updated.revision, connection: (await projectConnections(siteId, userId, [updated]))[0] };
}